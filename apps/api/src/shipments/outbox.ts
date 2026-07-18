// Email-outbox dispatcher (ARCHITECTURE.md §4, outbox pattern): rows are
// queued in the same transaction as their domain event; this worker renders
// and sends them afterwards. Magic-link emails are excluded — the auth flow
// sends those inline for latency and keeps its outbox row as the audit
// record (apps/api/src/routes/auth.ts).

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { emailOutbox, hubs, shipments } from '@mercurio/db';
import type { SendMail } from '../lib/mailer.js';

const LIFECYCLE_TEMPLATES = [
  'parcel_tracking',
  'parcel_at_intermediate_hub',
  'parcel_arrived',
  'parcel_delivered',
  'handoff_rejected',
  'storage_expiry_warning',
  // Addressed to the HUB owner, not a shipment party (Fase 2 punto 6, ADR-028):
  // a deposit request landed and awaits the hub's manual accept/refuse.
  'hub_deposit_request',
  // Addressed to the CARRIER (ADR-029): their deposit request was refused or
  // expired unanswered — the shipment is back on the board, pick another hub.
  'deposit_request_rejected',
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

// The shipment's codename is what a person reads and says (Fase 1 punto 1);
// the email cites it instead of the raw UUID. Looked up here rather than
// threaded through the pure state machine, which has no reason to carry a
// display label. Falls back to the id if the row somehow can't be read.
async function shipmentLabel(db: Db, shipmentId: unknown): Promise<string> {
  if (typeof shipmentId !== 'string') return String(shipmentId ?? '');
  const [s] = await db
    .select({ codename: shipments.codename })
    .from(shipments)
    .where(eq(shipments.id, shipmentId));
  return s?.codename ?? shipmentId;
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
  // The codename leads every subject so a shipment is recognizable in an
  // inbox (Fase 1 punto 1: mostralo anche nei titoli) and is repeated on the
  // "Spedizione:" line for anyone who quotes it to an hub or to support.
  const codename = await shipmentLabel(db, payload.shipmentId);
  switch (template) {
    case 'parcel_tracking':
      return {
        subject: `Mercurio ${codename} — il tuo pacco è in viaggio: codice personale di tracking e ritiro`,
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
          `Spedizione: ${codename}` +
          firstContactFooter(),
      };
    case 'parcel_at_intermediate_hub':
      return {
        subject: `Mercurio ${codename} — il pacco è arrivato in un hub intermedio`,
        text:
          `Il pacco è stato depositato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Resta in attesa di un vettore per la tratta successiva.\n\n` +
          `Dettagli e tracking: ${recipientLink(payload.shipmentId)}\n` +
          `Spedizione: ${codename}` +
          privacyFooter(),
      };
    case 'parcel_arrived':
      return {
        subject: `Mercurio ${codename} — il tuo pacco è arrivato: ritiralo con questo codice`,
        text:
          `Il pacco è arrivato presso ${await hubLabel(db, payload.hubId)}.\n` +
          `Il ritiro è gratuito. Presenta questo codice di ritiro (OTP): ${String(payload.otp ?? '')}\n` +
          `Digitarlo al ritiro vale come accettazione definitiva del pacco (ispezionalo prima).\n\n` +
          `Dettagli e tracking: ${recipientLink(payload.shipmentId)}\n` +
          `Spedizione: ${codename}` +
          privacyFooter(),
      };
    case 'parcel_delivered':
      return {
        subject: `Mercurio ${codename} — pacco consegnato`,
        text:
          `Il destinatario ha ritirato il pacco: la spedizione è conclusa.\n\n` +
          `Dettagli: ${senderLink(payload.shipmentId)}\n` +
          `Spedizione: ${codename}` +
          privacyFooter(),
      };
    case 'handoff_rejected':
      return {
        subject: `Mercurio ${codename} — un passaggio di mano è stato rifiutato`,
        text:
          `Un passaggio di mano è stato rifiutato (fase: ${String(payload.stage ?? '?')}).\n` +
          `Motivo: ${String(payload.reason ?? '')}\n` +
          `La custodia non è passata e lo stato non è cambiato; puoi valutare un reroute o un boost.\n\n` +
          `Dettagli: ${senderLink(payload.shipmentId)}\n` +
          `Spedizione: ${codename}` +
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
        subject: `Mercurio ${codename} — giacenza in scadenza: il pacco sta per essere svincolato`,
        text: intro + action + `Spedizione: ${codename}` + privacyFooter(),
      };
    }
    case 'deposit_request_rejected': {
      // To the carrier whose leg_request died (ADR-029): zero money moved —
      // the message is purely "pick another hub", with the reason when the
      // hub gave one (outcome 'rejected') or the timeout notice ('expired').
      const rejectedLine =
        payload.outcome === 'rejected'
          ? `L'hub ${await hubLabel(db, payload.hubId)} ha rifiutato la tua richiesta di deposito.\n` +
            (payload.reason ? `Motivo: ${String(payload.reason)}\n` : '')
          : `L'hub ${await hubLabel(db, payload.hubId)} non ha risposto in tempo alla tua richiesta di deposito.\n`;
      return {
        subject: `Mercurio ${codename} — richiesta di deposito non accolta`,
        text:
          rejectedLine +
          `Nessun fondo è stato impegnato. La spedizione è di nuovo in bacheca:\n` +
          `puoi scegliere un altro hub di consegna.\n\n` +
          `Spedizione: ${codename}` +
          privacyFooter(),
      };
    }
    case 'hub_deposit_request':
      // To the hub owner (its venue contact address, or the account email —
      // ADR-028). The numbers that decide the accept (bond, projected earning
      // with sats + €) live on the dashboard, which is authoritative; the mail
      // carries what matters at a glance and a link.
      return {
        subject: `Mercurio ${codename} — nuova richiesta di deposito nel tuo hub`,
        text:
          `Una nuova spedizione ti chiede di custodire un pacco in partenza da ${await hubLabel(db, payload.hubId)}.\n` +
          `Destinazione: ${await hubLabel(db, payload.destHubId)}.\n` +
          `Giacenza massima richiesta: ${String(payload.maxStorageDays ?? '?')} giorni.\n` +
          (payload.undeclared ? `Contenuto NON dichiarato dal mittente.\n` : '') +
          `\nApri la dashboard del tuo hub per vedere bond, guadagno stimato e\n` +
          `accettare o rifiutare: ${webUrl()}/hub\n` +
          `Spedizione: ${codename}` +
          privacyFooter(),
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
