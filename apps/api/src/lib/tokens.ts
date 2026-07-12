import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque bearer tokens (magic-link tokens, session tokens). Only the SHA-256
 * hash is ever persisted (ADR-009): a database read alone cannot
 * authenticate as anyone, since the raw token never touches storage.
 */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
