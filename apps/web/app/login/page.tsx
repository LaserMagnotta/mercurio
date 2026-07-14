'use client';

// Magic-link request (ADR-009): email in, 202 out, same response whether or
// not the account exists — the page communicates only "check your inbox".

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { requestLoginLink } from '../../lib/api/endpoints';
import { ApiError } from '../../lib/api/client';
import { useApiErrorMessage } from '../../lib/api-error-message';

export default function LoginPage() {
  const t = useTranslations('auth');
  const errorMessage = useApiErrorMessage();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setState('sending');
    try {
      await requestLoginLink(email);
      setState('sent');
    } catch (err) {
      setState('idle');
      setError(
        err instanceof ApiError && err.status === 429
          ? t('errors.rate_limited')
          : errorMessage(err),
      );
    }
  };

  if (state === 'sent') {
    return (
      <div className="card stack-sm">
        <h1>{t('sentTitle')}</h1>
        <p className="muted">{t('sentBody')}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>{t('loginTitle')}</h1>
      <p className="muted">{t('loginIntro')}</p>
      <form className="card" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="email">{t('emailLabel')}</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={state === 'sending'}>
          {state === 'sending' ? t('sending') : t('submit')}
        </button>
      </form>
    </div>
  );
}
