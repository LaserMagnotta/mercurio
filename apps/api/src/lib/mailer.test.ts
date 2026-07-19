import { describe, expect, it } from 'vitest';
import { mailerConfigFromEnv } from './mailer.js';

describe('mailerConfigFromEnv', () => {
  it('defaults to the dev Mailpit fixture with no configuration at all', () => {
    expect(mailerConfigFromEnv({})).toEqual({
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'Mercurio <no-reply@mercurio.local>',
    });
  });

  it('takes host, port, sender and credentials from the environment (ADR-024)', () => {
    expect(
      mailerConfigFromEnv({
        SMTP_HOST: 'smtp.relay.example',
        SMTP_PORT: '587',
        SMTP_USER: 'postmaster@mercurio.example',
        SMTP_PASS: 'placeholder-secret',
        SMTP_FROM: 'Mercurio <no-reply@mercurio.example>',
      }),
    ).toEqual({
      host: 'smtp.relay.example',
      port: 587,
      secure: false, // 587 starts in clear and upgrades via STARTTLS
      auth: { user: 'postmaster@mercurio.example', pass: 'placeholder-secret' },
      from: 'Mercurio <no-reply@mercurio.example>',
    });
  });

  it('infers implicit TLS on port 465, and lets SMTP_SECURE override either way', () => {
    expect(mailerConfigFromEnv({ SMTP_PORT: '465' }).secure).toBe(true);
    expect(mailerConfigFromEnv({ SMTP_PORT: '465', SMTP_SECURE: 'false' }).secure).toBe(false);
    expect(mailerConfigFromEnv({ SMTP_PORT: '587', SMTP_SECURE: 'true' }).secure).toBe(true);
  });

  it('omits auth entirely when no credentials are given (Mailpit accepts anonymous)', () => {
    expect(mailerConfigFromEnv({ SMTP_HOST: 'mailpit' })).not.toHaveProperty('auth');
  });

  it('refuses half-configured credentials rather than failing at the first email', () => {
    expect(() => mailerConfigFromEnv({ SMTP_USER: 'someone' })).toThrow(/together/);
    expect(() => mailerConfigFromEnv({ SMTP_PASS: 'placeholder-secret' })).toThrow(/together/);
  });

  it('refuses a non-numeric port', () => {
    expect(() => mailerConfigFromEnv({ SMTP_PORT: 'not-a-port' })).toThrow(/SMTP_PORT/);
  });
});
