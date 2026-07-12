export type AuthErrorCode =
  | 'invalid_token'
  | 'token_expired'
  | 'token_already_used'
  | 'consent_required'
  | 'account_deleted'
  | 'rate_limited';

export class AuthError extends Error {
  constructor(public code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
  }
}
