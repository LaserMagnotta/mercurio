'use client';

// The "Spedisci" form (CLAUDE.md flow step 1). Validation reuses the SHARED
// Zod schema `createShipmentBody` (ADR-002: client and server cannot drift).
// Amounts are sats-first (ADR-008): the suggested offer arrives from the API
// in BOTH currencies plus the snapshot, so this page never converts money —
// the only client-side arithmetic is the indicative € line under the inputs,
// rendered from the API-provided rate.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { ZodIssue } from 'zod';
import { createShipmentBody, MAX_STORAGE_HOURS } from '@mercurio/shared';
import {
  createShipment,
  getHubs,
  getSuggestedOffer,
  getWallet,
  type Hub,
  type SuggestedOffer,
} from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { useSession } from '../../lib/session';
import { formatEurIndicative, formatKm, formatSats, satsToMsat } from '../../lib/format';
import { rememberShipment } from '../../lib/recent';
import { HubCard } from '../../components/HubCard';

const SATS_RE = /^\d{1,15}$/;

type FieldKey =
  | 'originHubId'
  | 'destHubId'
  | 'recipientEmail'
  | 'lengthCm'
  | 'widthCm'
  | 'heightCm'
  | 'weightG'
  | 'offerMsat'
  | 'custodyBondMsat'
  | 'maxStorageHours';

/** Zod issue → per-field message key under send.validation. */
function issueMessageKey(issue: ZodIssue): string {
  if (issue.code === 'invalid_string' && 'validation' in issue && issue.validation === 'email') {
    return 'email';
  }
  if (issue.code === 'invalid_string') return 'sats';
  if (issue.code === 'too_big') return 'tooHigh';
  if (issue.code === 'too_small' || issue.code === 'invalid_type') return 'positiveInt';
  return 'invalid';
}

function issueField(issue: ZodIssue): FieldKey | null {
  const [head, second] = issue.path;
  if (head === 'dims' && typeof second === 'string') return second as FieldKey;
  if (typeof head === 'string') return head as FieldKey;
  return null;
}

export default function SendPage() {
  const t = useTranslations('send');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const { user, loading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [hubs, setHubs] = useState<Hub[]>([]);
  const [walletConnected, setWalletConnected] = useState<boolean | null>(null);

  const [originHubId, setOriginHubId] = useState('');
  const [destHubId, setDestHubId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [lengthCm, setLengthCm] = useState('');
  const [widthCm, setWidthCm] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightG, setWeightG] = useState('');
  const [declaredContent, setDeclaredContent] = useState('');
  const [undeclared, setUndeclared] = useState(false);
  const [maxStorageHours, setMaxStorageHours] = useState('48');
  const [offerSats, setOfferSats] = useState('');
  const [bondSats, setBondSats] = useState('');

  const [suggestion, setSuggestion] = useState<SuggestedOffer | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getHubs()
      .then((res) => setHubs(res.hubs))
      .catch(() => setHubs([]));
  }, []);

  useEffect(() => {
    if (!user) return;
    getWallet()
      .then((res) => setWalletConnected(res.wallet !== null))
      .catch(() => setWalletConnected(false));
  }, [user]);

  // Suggested offer (MATCHING.md §5) as soon as the route is known.
  useEffect(() => {
    setSuggestion(null);
    if (!originHubId || !destHubId || originHubId === destHubId) return;
    let cancelled = false;
    setSuggestionLoading(true);
    getSuggestedOffer(originHubId, destHubId)
      .then((res) => {
        if (!cancelled) setSuggestion(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSuggestionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [originHubId, destHubId]);

  const originHub = useMemo(() => hubs.find((h) => h.id === originHubId), [hubs, originHubId]);
  const destHub = useMemo(() => hubs.find((h) => h.id === destHubId), [hubs, destHubId]);
  const storageCap = Math.min(
    MAX_STORAGE_HOURS,
    originHub?.maxStorageHours ?? MAX_STORAGE_HOURS,
    destHub?.maxStorageHours ?? MAX_STORAGE_HOURS,
  );
  /** Current indicative rate for the sats inputs (from the suggestion). */
  const inputRate = suggestion?.eurRate.satsPerEur ?? null;

  const eurUnder = (sats: string) =>
    SATS_RE.test(sats) && inputRate
      ? formatEurIndicative(satsToMsat(BigInt(sats)), inputRate, locale)
      : null;

  if (loading) return <p className="muted">{tCommon('loading')}</p>;
  if (!user) {
    return (
      <div className="card stack-sm">
        <h1>{t('title')}</h1>
        <p className="muted">{tCommon('loginRequired')}</p>
        <Link className="btn btn-primary" href="/login">
          {tCommon('loginCta')}
        </Link>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const errors: Partial<Record<FieldKey, string>> = {};

    if (originHubId && originHubId === destHubId) {
      errors.destHubId = t('sameHub');
    }
    for (const [field, value] of [
      ['offerMsat', offerSats],
      ['custodyBondMsat', bondSats],
    ] as const) {
      if (!SATS_RE.test(value)) errors[field] = t('validation.sats');
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const candidate = {
      originHubId,
      destHubId,
      recipientEmail,
      dims: {
        lengthCm: Number(lengthCm),
        widthCm: Number(widthCm),
        heightCm: Number(heightCm),
      },
      weightG: Number(weightG),
      ...(declaredContent.trim() !== '' && { declaredContent: declaredContent.trim() }),
      undeclared,
      offerMsat: satsToMsat(BigInt(offerSats)),
      custodyBondMsat: satsToMsat(BigInt(bondSats)),
      maxStorageHours: Number(maxStorageHours),
    };
    const parsed = createShipmentBody.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issueField(issue);
        if (field && !errors[field]) errors[field] = t(`validation.${issueMessageKey(issue)}`);
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setBusy(true);
    try {
      const created = await createShipment(parsed.data);
      rememberShipment(created.id);
      router.push(`/shipments/${created.id}?created=1`);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setBusy(false);
    }
  };

  const fieldError = (key: FieldKey) =>
    fieldErrors[key] ? (
      <span className="field-error" role="alert">
        {fieldErrors[key]}
      </span>
    ) : null;

  return (
    <div className="stack">
      <h1>{t('title')}</h1>

      {walletConnected === false && (
        <div className="alert alert-warning stack-sm">
          <p>{t('needWallet')}</p>
          <Link className="btn" href="/wallet">
            {t('goWallet')}
          </Link>
        </div>
      )}

      <form className="card" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="origin">{t('originLabel')}</label>
          <select
            id="origin"
            value={originHubId}
            onChange={(e) => setOriginHubId(e.target.value)}
            aria-invalid={fieldErrors.originHubId !== undefined}
          >
            <option value="">{t('selectHub')}</option>
            {hubs.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} — {h.address}
              </option>
            ))}
          </select>
          {fieldError('originHubId')}
        </div>
        {originHub && <HubCard hub={originHub} />}

        <div className="field">
          <label htmlFor="dest">{t('destLabel')}</label>
          <select
            id="dest"
            value={destHubId}
            onChange={(e) => setDestHubId(e.target.value)}
            aria-invalid={fieldErrors.destHubId !== undefined}
          >
            <option value="">{t('selectHub')}</option>
            {hubs
              .filter((h) => h.id !== originHubId)
              .map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} — {h.address}
                </option>
              ))}
          </select>
          {fieldError('destHubId')}
        </div>
        {destHub && <HubCard hub={destHub} />}

        <div className="field">
          <label htmlFor="recipient">{t('recipientLabel')}</label>
          <input
            id="recipient"
            type="email"
            autoComplete="off"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            aria-invalid={fieldErrors.recipientEmail !== undefined}
          />
          <span className="hint">{t('recipientHint')}</span>
          {fieldError('recipientEmail')}
        </div>

        <fieldset>
          <legend>{t('dimsLegend')}</legend>
          <div className="dims-grid">
            <div className="field">
              <label htmlFor="len">{t('lengthLabel')}</label>
              <input
                id="len"
                type="number"
                min="1"
                inputMode="numeric"
                value={lengthCm}
                onChange={(e) => setLengthCm(e.target.value)}
                aria-invalid={fieldErrors.lengthCm !== undefined}
              />
              {fieldError('lengthCm')}
            </div>
            <div className="field">
              <label htmlFor="wid">{t('widthLabel')}</label>
              <input
                id="wid"
                type="number"
                min="1"
                inputMode="numeric"
                value={widthCm}
                onChange={(e) => setWidthCm(e.target.value)}
                aria-invalid={fieldErrors.widthCm !== undefined}
              />
              {fieldError('widthCm')}
            </div>
            <div className="field">
              <label htmlFor="hei">{t('heightLabel')}</label>
              <input
                id="hei"
                type="number"
                min="1"
                inputMode="numeric"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                aria-invalid={fieldErrors.heightCm !== undefined}
              />
              {fieldError('heightCm')}
            </div>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="weight">{t('weightLabel')}</label>
          <input
            id="weight"
            type="number"
            min="1"
            inputMode="numeric"
            value={weightG}
            onChange={(e) => setWeightG(e.target.value)}
            aria-invalid={fieldErrors.weightG !== undefined}
          />
          {fieldError('weightG')}
        </div>

        <div className="field">
          <label htmlFor="content">{t('contentLabel')}</label>
          <textarea
            id="content"
            value={declaredContent}
            onChange={(e) => setDeclaredContent(e.target.value)}
            disabled={undeclared}
            maxLength={500}
          />
          <span className="hint">{t('contentHint')}</span>
        </div>

        <div className="checkbox-row">
          <input
            id="undeclared"
            type="checkbox"
            checked={undeclared}
            onChange={(e) => {
              setUndeclared(e.target.checked);
              if (e.target.checked) setDeclaredContent('');
            }}
          />
          <label htmlFor="undeclared">
            {t('undeclaredLabel')} <span className="hint">{t('undeclaredHint')}</span>
          </label>
        </div>

        <div className="field">
          <label htmlFor="storage">{t('storageLabel')}</label>
          <input
            id="storage"
            type="number"
            min="1"
            max={storageCap}
            inputMode="numeric"
            value={maxStorageHours}
            onChange={(e) => setMaxStorageHours(e.target.value)}
            aria-invalid={fieldErrors.maxStorageHours !== undefined}
          />
          <span className="hint">{t('storageHint', { max: storageCap })}</span>
          {fieldError('maxStorageHours')}
        </div>

        <div className="field">
          <label htmlFor="offer">{t('offerLabel')}</label>
          <input
            id="offer"
            type="text"
            inputMode="numeric"
            value={offerSats}
            onChange={(e) => setOfferSats(e.target.value)}
            aria-invalid={fieldErrors.offerMsat !== undefined}
          />
          {eurUnder(offerSats) && (
            <span className="hint" title={tCommon('indicativeNote')}>
              ≈ {eurUnder(offerSats)}
            </span>
          )}
          <span className="hint">{t('offerHint')}</span>
          {fieldError('offerMsat')}
        </div>

        {suggestionLoading && <p className="hint">{t('suggestionLoading')}</p>}
        {suggestion && (
          <div className="alert alert-info stack-sm">
            <strong>{t('suggestionTitle')}</strong>
            <p className="small">
              {t('suggestionBody', {
                eur: formatEurIndicative(
                  suggestion.suggestedMsat,
                  suggestion.eurRate.satsPerEur,
                  locale,
                ),
                sats: formatSats(suggestion.suggestedMsat, locale),
                km: formatKm(suggestion.routeKm, locale),
              })}{' '}
              {t('suggestionPriority')}
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOfferSats((BigInt(suggestion.suggestedMsat) / 1000n).toString())}
            >
              {t('suggestionApply', { sats: formatSats(suggestion.suggestedMsat, locale) })}
            </button>
          </div>
        )}

        <div className="field">
          <label htmlFor="bond">{t('bondLabel')}</label>
          <input
            id="bond"
            type="text"
            inputMode="numeric"
            value={bondSats}
            onChange={(e) => setBondSats(e.target.value)}
            aria-invalid={fieldErrors.custodyBondMsat !== undefined}
          />
          {eurUnder(bondSats) && (
            <span className="hint" title={tCommon('indicativeNote')}>
              ≈ {eurUnder(bondSats)}
            </span>
          )}
          <span className="hint">{t('bondHint')}</span>
          {fieldError('custodyBondMsat')}
        </div>

        {submitError && (
          <p className="field-error" role="alert">
            {submitError}
          </p>
        )}

        <button className="btn btn-primary btn-block" disabled={busy || walletConnected === false}>
          {busy ? t('creating') : t('submit')}
        </button>
      </form>
    </div>
  );
}
