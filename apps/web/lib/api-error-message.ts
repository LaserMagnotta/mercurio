'use client';

// ApiError → user copy. The API speaks machine-readable codes; the catalog
// under `apiErrors` carries the human copy for the ones the UI can meet.
// KNOWN_API_ERROR_CODES is unit-tested against BOTH locale catalogs so a
// mapped code can never ship half-translated.

import { useTranslations } from 'next-intl';
import { ApiError } from './api/client';
import { KNOWN_API_ERROR_CODES } from './api-error-codes';

const KNOWN = new Set<string>(KNOWN_API_ERROR_CODES);

export function useApiErrorMessage(): (err: unknown) => string {
  const t = useTranslations('apiErrors');
  return (err: unknown) => {
    if (err instanceof ApiError) {
      const code = err.status === 401 ? 'http_401' : err.code;
      if (KNOWN.has(code)) return t(code);
      return t('fallback', { code });
    }
    return t('fallback', { code: 'unknown' });
  };
}
