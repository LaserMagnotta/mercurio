import nodemailer from 'nodemailer';

export type SendMail = (params: { to: string; subject: string; text: string }) => Promise<void>;

export interface MailerConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (SMTPS, port 465 by convention). On 587
   *  and 25 the session starts in clear and nodemailer upgrades it via
   *  STARTTLS by itself, so `false` is not the same as "unencrypted". */
  secure: boolean;
  /** Omitted for Mailpit, which accepts anything; every real relay needs it. */
  auth?: { user: string; pass: string };
  from: string;
}

/** Mailpit accepts any sender; a real relay will not (SPF/DKIM must align
 *  with a domain you own), so production sets SMTP_FROM — ADR-024. */
const DEV_FROM = 'Mercurio <no-reply@mercurio.local>';

/**
 * SMTP settings from the environment. The defaults are Mailpit's
 * (infra/docker/docker-compose.yml): development configures nothing.
 */
export function mailerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailerConfig {
  const port = Number(env.SMTP_PORT ?? 1025);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive integer, got ${JSON.stringify(env.SMTP_PORT)}`);
  }
  const { SMTP_USER: user, SMTP_PASS: pass } = env;
  // Half-configured auth means either anonymous delivery attempts against a
  // relay that requires login, or credentials silently dropped: both fail at
  // the first email sent, long after startup. Refuse now instead.
  if ((user === undefined) !== (pass === undefined)) {
    throw new Error('SMTP_USER and SMTP_PASS must be set together');
  }
  return {
    host: env.SMTP_HOST ?? 'localhost',
    port,
    secure: env.SMTP_SECURE !== undefined ? env.SMTP_SECURE === 'true' : port === 465,
    ...(user !== undefined && pass !== undefined && { auth: { user, pass } }),
    from: env.SMTP_FROM ?? DEV_FROM,
  };
}

/** Points at Mailpit in dev (infra/docker/docker-compose.yml); configurable via env for prod SMTP. */
export function createMailer(): SendMail {
  const { from, ...transport } = mailerConfigFromEnv();
  const mailer = nodemailer.createTransport(transport);

  return async ({ to, subject, text }) => {
    await mailer.sendMail({ from, to, subject, text });
  };
}
