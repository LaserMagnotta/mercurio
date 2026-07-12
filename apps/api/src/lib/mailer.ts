import nodemailer from 'nodemailer';

export type SendMail = (params: { to: string; subject: string; text: string }) => Promise<void>;

/** Points at Mailpit in dev (infra/docker/docker-compose.yml); configurable via env for prod SMTP. */
export function createMailer(): SendMail {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: false,
  });

  return async ({ to, subject, text }) => {
    await transport.sendMail({ from: 'Mercurio <no-reply@mercurio.local>', to, subject, text });
  };
}
