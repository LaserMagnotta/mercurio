'use client';

// Magic-link verification (ADR-009). First-ever login of an address needs
// explicit GDPR consent: the API answers 428 consent_required WITHOUT
// consuming the token, the page collects the consent and resubmits the same
// token with the accepted versions.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { verifyMagicLink } from '../../../lib/api/endpoints';
import { ApiError } from '../../../lib/api/client';
import { useSession } from '../../../lib/session';

/** Versions recorded in consent_events; bump when the documents change.
 *  Must match the versions published on /tos and /privacy (legal catalogs). */
const TOS_VERSION = '2026-07-17';
const PRIVACY_VERSION = '2026-07-17';

type Phase = 'verifying' | 'consent' | 'error';

const KNOWN_AUTH_ERRORS = new Set([
  'invalid_token',
  'token_expired',
  'token_already_used',
  'account_deleted',
  'rate_limited',
]);

export function VerifyClient() {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const token = params.get('token');

  const [phase, setPhase] = useState<Phase>('verifying');
  const [errorCode, setErrorCode] = useState<string>('invalid_token');
  const [accepted, setAccepted] = useState(false);
  // Specific approval of the onerous clauses (ToS §15, artt. 1341-1342 c.c.):
  // a separate, dedicated tick — not folded into the general acceptance.
  const [approvedClauses, setApprovedClauses] = useState(false);
  const attempted = useRef(false);

  const finishLogin = async () => {
    await refresh();
    router.replace('/');
  };

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'consent_required') {
      setPhase('consent');
      return;
    }
    setErrorCode(
      err instanceof ApiError && KNOWN_AUTH_ERRORS.has(err.code) ? err.code : 'invalid_token',
    );
    setPhase('error');
  };

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    if (!token) {
      setPhase('error');
      return;
    }
    verifyMagicLink(token).then(finishLogin).catch(fail);
  }, [token]);

  const submitConsent = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !accepted || !approvedClauses) return;
    try {
      await verifyMagicLink(token, {
        tosVersion: TOS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      });
      await finishLogin();
    } catch (err) {
      fail(err);
    }
  };

  if (phase === 'verifying') {
    return (
      <div className="card">
        <h1>{t('verifyTitle')}</h1>
        <p className="muted" aria-live="polite">
          {t('verifying')}
        </p>
      </div>
    );
  }

  if (phase === 'consent') {
    return (
      <div className="card stack-sm">
        <h1>{t('consentTitle')}</h1>
        <p className="muted">{t('consentBody')}</p>
        <p className="row small">
          {/* New tab on purpose: navigating away would abandon the pending,
              still-unconsumed magic-link token of this page. */}
          <Link href="/tos" target="_blank" rel="noopener">
            {tCommon('tosLink')}
          </Link>
          <Link href="/privacy" target="_blank" rel="noopener">
            {tCommon('privacyLink')}
          </Link>
        </p>
        <p className="muted small">{t('consentReadNote')}</p>
        <form onSubmit={submitConsent} className="stack-sm">
          <div className="checkbox-row">
            <input
              id="consent"
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <label htmlFor="consent">{t('consentCheckbox')}</label>
          </div>
          <div className="checkbox-row">
            <input
              id="consent-clauses"
              type="checkbox"
              checked={approvedClauses}
              onChange={(e) => setApprovedClauses(e.target.checked)}
            />
            <label htmlFor="consent-clauses" className="small">
              {t('consentSpecificCheckbox')}
            </label>
          </div>
          <button className="btn btn-primary btn-block" disabled={!accepted || !approvedClauses}>
            {t('consentSubmit')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="card stack-sm">
      <h1>{t('verifyTitle')}</h1>
      <p className="field-error" role="alert">
        {token ? t(`errors.${errorCode}`) : t('missingToken')}
      </p>
      <Link className="btn" href="/login">
        {t('requestNew')}
      </Link>
    </div>
  );
}
