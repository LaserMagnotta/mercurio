// Email-outbox dispatcher (ARCHITECTURE.md §4, outbox pattern): rows are
// queued in the same transaction as their domain event; this worker renders
// and sends them afterwards. Magic-link emails are excluded — the auth flow
// sends those inline for latency and keeps its outbox row as the audit
// record (apps/api/src/routes/auth.ts).

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { emailOutbox, hubs } from '@mercurio/db';
import type { SendMail } from '../lib/mailer';

const LIFECYCLE_TEMPLATES = [
  'parcel_at_intermediate_hub',
  'parcel_arrived',
  'parcel_delivered',
  'handoff_rejected',
] as const;

const MAX_ATTEMPTS = 5;

export interface OutboxDeps {
  db: Db;
  sendMail: SendMail;
  now: () => Date;
}

interface RenderedEmail {
  subject: string;
  text: string;
}

async function hubLabel(db: Db, hubId: unknown): Promise<string> {
  if (typeof hubId !== 'string') return 'un hub Mercurio';
  const [hub] = await db
    .select({ name: hubs.name, address: hubs.address })
    .from(hubs)
    .where(eq(hubs.id, hubId));
  return hub ? `${hub.name} (${hub.address})` : 'un hub Mercurio';
}

/** UI language is Italian (CLAUDE.md); templates stay minimal plain text. */
async function render(
  db: Db,
  template: string,
  payload: Record<string, unknown>,
): Promise<RenderedEmail | null> {
  switch (template) {
    case 'parcel_at_intermediate_hub':
      return {
        subject: 'Mercurio — il pacco è arrivato in un hub intermedio',
        text:
          `Il pacco è stato depositato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Resta in attesa di un vettore per la tratta successiva.\n\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}`,
      };
    case 'parcel_arrived':
      return {
        subject: 'Mercurio — il tuo pacco è arrivato: ritiralo con questo codice',
        text:
          `Il pacco è arrivato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Il ritiro è gratuito. Presenta questo codice di ritiro (OTP): ${String(payload.otp ?? '')}\n` +
          `Digitarlo al ritiro vale come accettazione definitiva del pacco (ispezionalo prima).\n\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}`,
      };
    case 'parcel_delivered':
      return {
        subject: 'Mercurio — pacco consegnato',
        text:
          `Il destinatario ha ritirato il pacco: la spedizione è conclusa.\n\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}`,
      };
    case 'handoff_rejected':
      return {
        subject: 'Mercurio — un passaggio di mano è stato rifiutato',
        text:
          `Un passaggio di mano è stato rifiutato (fase: ${String(payload.stage ?? '?')}).\n` +
          `Motivo: ${String(payload.reason ?? '')}\n` +
          `La custodia non è passata e lo stato non è cambiato; puoi valutare un reroute o un boost.\n\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}`,
      };
    default:
      return null;
  }
}

export interface OutboxResult {
  sent: number;
  failed: number;
}

export async function dispatchEmailOutbox(deps: OutboxDeps, limit = 20): Promise<OutboxResult> {
  const pending = await deps.db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, 'pending'),
        inArray(emailOutbox.template, [...LIFECYCLE_TEMPLATES]),
        lt(emailOutbox.attempts, MAX_ATTEMPTS),
      ),
    )
    .limit(limit);

  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    const rendered = await render(deps.db, row.template, row.payload as Record<string, unknown>);
    if (!rendered) {
      await deps.db
        .update(emailOutbox)
        .set({ status: 'failed' })
        .where(eq(emailOutbox.id, row.id));
      failed += 1;
      continue;
    }
    try {
      await deps.sendMail({ to: row.to, subject: rendered.subject, text: rendered.text });
      await deps.db
        .update(emailOutbox)
        .set({ status: 'sent', sentAt: deps.now() })
        .where(eq(emailOutbox.id, row.id));
      sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.db
        .update(emailOutbox)
        .set({
          attempts: sql`${emailOutbox.attempts} + 1`,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        })
        .where(eq(emailOutbox.id, row.id));
      failed += 1;
      console.warn(`outbox ${row.id} send failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { sent, failed };
}
