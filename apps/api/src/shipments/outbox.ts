// Email-outbox dispatcher (ARCHITECTURE.md §4, outbox pattern): rows are
// queued in the same transaction as their domain event; this worker renders
// and sends them afterwards. Magic-link emails are excluded — the auth flow
// sends those inline for latency and keeps its outbox row as the audit
// record (apps/api/src/routes/auth.ts).

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { emailOutbox, hubs } from '@mercurio/db';
import type { SendMail } from '../lib/mailer.js';

const LIFECYCLE_TEMPLATES = [
  'parcel_tracking',
  'parcel_at_intermediate_hub',
  'parcel_arrived',
  'parcel_delivered',
  'handoff_rejected',
  'storage_expiry_warning',
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

// Web pages the emails point at (same WEB_URL knob as the magic links in
// routes/auth.ts). The URLs carry only the shipment id — NEVER the claim
// token or the OTP: those stay in the email body as bearer credentials.
const webUrl = () => process.env.WEB_URL ?? 'http://localhost:3000';
const recipientLink = (shipmentId: unknown) => `${webUrl()}/track/${String(shipmentId ?? '')}`;
const senderLink = (shipmentId: unknown) => `${webUrl()}/shipments/${String(shipmentId ?? '')}`;

// Privacy notice in every lifecycle mail (RISKS.md §6: art. 21 GDPR objection
// link in each message); parcel_tracking is the recipient's FIRST contact and
// additionally carries the art. 14 source-of-data line.
const privacyFooter = () =>
  `\n\n—\nInformativa privacy e diritto di opposizione (art. 21 GDPR): ${webUrl()}/privacy`;
const firstContactFooter = () =>
  `\n\n—\nRicevi questa email perché il mittente ha indicato questo indirizzo come` +
  `\ndestinatario della spedizione (art. 14 GDPR).` +
  `\nInformativa privacy e diritto di opposizione (art. 21 GDPR): ${webUrl()}/privacy`;

/** UI language is Italian (CLAUDE.md); templates stay minimal plain text. */
async function render(
  db: Db,
  template: string,
  payload: Record<string, unknown>,
): Promise<RenderedEmail | null> {
  switch (template) {
    case 'parcel_tracking':
      return {
        subject: 'Mercurio — il tuo pacco è in viaggio: codice personale di tracking e ritiro',
        text:
          `Un pacco per te è stato consegnato a ${await hubLabel(db, payload.hubId)} ed è in viaggio.\n` +
          `Riceverai una mail a ogni tappa.\n\n` +
          `Questo è il tuo codice personale: ${String(payload.claimToken ?? '')}\n` +
          `Con questo codice puoi RITIRARE IN ANTICIPO il pacco mentre è fermo in un hub\n` +
          `qualsiasi del percorso, incassando tu il compenso residuo della spedizione\n` +
          `(serve un account Mercurio con wallet Lightning collegato). Presentalo all'hub\n` +
          `al momento del ritiro: accettare il pacco vale come accettazione definitiva.\n` +
          `Non condividerlo: chiunque lo possieda può reclamare il pacco.\n\n` +
          `Segui il pacco (e riscattalo, se vuoi) qui: ${recipientLink(payload.shipmentId)}\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}` +
          firstContactFooter(),
      };
    case 'parcel_at_intermediate_hub':
      return {
        subject: 'Mercurio — il pacco è arrivato in un hub intermedio',
        text:
          `Il pacco è stato depositato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Resta in attesa di un vettore per la tratta successiva.\n\n` +
          `Dettagli e tracking: ${recipientLink(payload.shipmentId)}\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}` +
          privacyFooter(),
      };
    case 'parcel_arrived':
      return {
        subject: 'Mercurio — il tuo pacco è arrivato: ritiralo con questo codice',
        text:
          `Il pacco è arrivato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Il ritiro è gratuito. Presenta questo codice di ritiro (OTP): ${String(payload.otp ?? '')}\n` +
          `Digitarlo al ritiro vale come accettazione definitiva del pacco (ispezionalo prima).\n\n` +
          `Dettagli e tracking: ${recipientLink(payload.shipmentId)}\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}` +
          privacyFooter(),
      };
    case 'parcel_delivered':
      return {
        subject: 'Mercurio — pacco consegnato',
        text:
          `Il destinatario ha ritirato il pacco: la spedizione è conclusa.\n\n` +
          `Dettagli: ${senderLink(payload.shipmentId)}\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}` +
          privacyFooter(),
      };
    case 'handoff_rejected':
      return {
        subject: 'Mercurio — un passaggio di mano è stato rifiutato',
        text:
          `Un passaggio di mano è stato rifiutato (fase: ${String(payload.stage ?? '?')}).\n` +
          `Motivo: ${String(payload.reason ?? '')}\n` +
          `La custodia non è passata e lo stato non è cambiato; puoi valutare un reroute o un boost.\n\n` +
          `Dettagli: ${senderLink(payload.shipmentId)}\n` +
          `Spedizione: ${String(payload.shipmentId ?? '')}` +
          privacyFooter(),
      };
    case 'storage_expiry_warning': {
      // RISKS.md §4 / ToS §10.1: warning while the storage timer is still
      // armed (storage-warnings.ts). Times are rendered in Italian time —
      // the UI language of the project (CLAUDE.md).
      const deadline = new Date(String(payload.deadline ?? ''));
      const when = Number.isNaN(deadline.getTime())
        ? '?'
        : deadline.toLocaleString('it-IT', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: 'Europe/Rome',
          });
      const intro =
        `La giacenza del pacco presso ${await hubLabel(db, payload.hubId)} scade il ${when} (ora italiana).\n` +
        `Alla scadenza il pacco diventa svincolabile a favore dell'hub secondo i Termini di\n` +
        `servizio (${webUrl()}/tos): resta poi una finestra di 7 giorni per recuperarlo pagando\n` +
        `la giacenza extra direttamente all'hub.\n\n`;
      const action =
        payload.audience === 'sender'
          ? `Puoi ancora far ripartire il pacco (boost), cambiarne la destinazione o richiamarlo\n` +
            `verso l'origine: ${senderLink(payload.shipmentId)}\n`
          : `Se ti conviene, puoi ritirarlo in anticipo con il tuo codice personale:\n` +
            `${recipientLink(payload.shipmentId)}\n`;
      return {
        subject: 'Mercurio — giacenza in scadenza: il pacco sta per essere svincolato',
        text:
          intro + action + `Spedizione: ${String(payload.shipmentId ?? '')}` + privacyFooter(),
      };
    }
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
