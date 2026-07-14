'use client';

// Trip declaration (MATCHING.md §1): the carrier declares the REAL journey
// BEFORE seeing the board. Origin/destination come from a hub picker (hubs
// are the network's known coordinates) or manual lat/lng; the minimum rate
// input is sats-first, prefilled from GET /trips/suggested-rate — which
// carries both the EUR copy ("carriers in your area accepted…", §4) and the
// server-computed msat equivalent.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { createTripBody } from '@mercurio/shared';
import {
  activateCarrierRole,
  createTrip,
  getHubs,
  getMyTrips,
  getSuggestedRate,
  getWallet,
  type Hub,
  type MeTrips,
  type SuggestedRate,
} from '../../lib/api/endpoints';
import { ApiError } from '../../lib/api/client';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { useSession } from '../../lib/session';
import { formatDateTime, formatEurIndicative, formatSats, satsToMsat } from '../../lib/format';

type Trip = MeTrips['items'][number];

/** Whether the most recently declared trip still admits board browsing
 *  (MATCHING.md §1): a trip row is never rewritten on expiry (ADR-018 §5 —
 *  GET /me/trips route note), so "active" is `status === 'active'` AND the
 *  deadline still ahead, checked here exactly like the board/route routes do. */
function isActive(trip: Trip): boolean {
  return trip.status === 'active' && new Date(trip.expiresAt).getTime() > Date.now();
}

const SATS_RE = /^\d{1,12}$/;

export default function CarrierPage() {
  const t = useTranslations('carrier');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const { user, loading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [hubs, setHubs] = useState<Hub[]>([]);
  const [walletConnected, setWalletConnected] = useState<boolean | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [suggested, setSuggested] = useState<SuggestedRate | null>(null);

  const [manualCoords, setManualCoords] = useState(false);
  const [originHubId, setOriginHubId] = useState('');
  const [destHubId, setDestHubId] = useState('');
  const [originLat, setOriginLat] = useState('');
  const [originLng, setOriginLng] = useState('');
  const [destLat, setDestLat] = useState('');
  const [destLng, setDestLng] = useState('');
  const [deviationKm, setDeviationKm] = useState('15');
  const [rateSats, setRateSats] = useState('');
  const [error, setError] = useState<string | null>(null);
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
    getSuggestedRate()
      .then(setSuggested)
      .catch(() => setSuggested(null));
    // Only the most recently declared trip counts as "the active trip"
    // banner (ADR-018 §5): same one-trip-at-a-time semantics the old
    // localStorage memory had.
    getMyTrips({ limit: 1 })
      .then((res) => setTrip(res.items[0] && isActive(res.items[0]) ? res.items[0] : null))
      .catch(() => setTrip(null));
  }, [user]);

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

  const coords = () => {
    if (manualCoords) {
      return {
        originLat: Number(originLat),
        originLng: Number(originLng),
        destLat: Number(destLat),
        destLng: Number(destLng),
      };
    }
    const origin = hubs.find((h) => h.id === originHubId);
    const dest = hubs.find((h) => h.id === destHubId);
    return {
      originLat: origin?.lat ?? Number.NaN,
      originLng: origin?.lng ?? Number.NaN,
      destLat: dest?.lat ?? Number.NaN,
      destLng: dest?.lng ?? Number.NaN,
    };
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!manualCoords && originHubId !== '' && originHubId === destHubId) {
      setError(t('sameOriginDest'));
      return;
    }
    if (!SATS_RE.test(rateSats)) {
      setError(t('validation.rate'));
      return;
    }
    const candidate = {
      ...coords(),
      maxDeviationKm: Number(deviationKm),
      minRateMsatPerKm: satsToMsat(BigInt(rateSats)),
    };
    const parsed = createTripBody.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === 'maxDeviationKm' ? t('validation.deviation') : t('validation.coords'),
      );
      return;
    }
    setBusy(true);
    try {
      // The carrier role is a one-time, idempotent activation: do it lazily
      // on the 403 rather than asking the user to know about roles.
      let created;
      try {
        created = await createTrip(parsed.data);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'carrier_role_required') {
          await activateCarrierRole();
          created = await createTrip(parsed.data);
        } else {
          throw err;
        }
      }
      router.push(`/carrier/trips/${created.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const hubSelect = (id: string, label: string, value: string, onChange: (v: string) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">{t('pickHub')}</option>
        {hubs.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name} — {h.address}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>

      {walletConnected === false && (
        <div className="alert alert-warning stack-sm">
          <p>{t('needWallet')}</p>
          <Link className="btn" href="/wallet">
            {t('goWallet')}
          </Link>
        </div>
      )}

      {trip && (
        <div className="card card-highlight stack-sm">
          <h2>{t('activeTrip')}</h2>
          <p className="muted small">
            {t('activeUntil', { time: formatDateTime(trip.expiresAt, locale) })}
          </p>
          <div className="row">
            <Link className="btn btn-primary" href={`/carrier/trips/${trip.id}`}>
              {t('goBoard')}
            </Link>
            <Link className="btn" href={`/carrier/trips/${trip.id}/route`}>
              {t('goRoute')}
            </Link>
          </div>
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <h2>{trip ? t('newTrip') : t('tripTitle')}</h2>

        {!manualCoords ? (
          <>
            {hubSelect('trip-origin', t('originLabel'), originHubId, setOriginHubId)}
            {hubSelect('trip-dest', t('destLabel'), destHubId, setDestHubId)}
          </>
        ) : (
          <>
            <fieldset>
              <legend>{t('originLabel')}</legend>
              <div className="dims-grid">
                <div className="field">
                  <label htmlFor="olat">{t('latLabel')}</label>
                  <input
                    id="olat"
                    type="number"
                    step="any"
                    value={originLat}
                    onChange={(e) => setOriginLat(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="olng">{t('lngLabel')}</label>
                  <input
                    id="olng"
                    type="number"
                    step="any"
                    value={originLng}
                    onChange={(e) => setOriginLng(e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('destLabel')}</legend>
              <div className="dims-grid">
                <div className="field">
                  <label htmlFor="dlat">{t('latLabel')}</label>
                  <input
                    id="dlat"
                    type="number"
                    step="any"
                    value={destLat}
                    onChange={(e) => setDestLat(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="dlng">{t('lngLabel')}</label>
                  <input
                    id="dlng"
                    type="number"
                    step="any"
                    value={destLng}
                    onChange={(e) => setDestLng(e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
          </>
        )}

        <div className="checkbox-row">
          <input
            id="manual"
            type="checkbox"
            checked={manualCoords}
            onChange={(e) => setManualCoords(e.target.checked)}
          />
          <label htmlFor="manual">{t('manualToggle')}</label>
        </div>

        <div className="field">
          <label htmlFor="deviation">{t('deviationLabel')}</label>
          <input
            id="deviation"
            type="number"
            min="1"
            max="500"
            inputMode="numeric"
            value={deviationKm}
            onChange={(e) => setDeviationKm(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="rate">{t('rateLabel')}</label>
          <input
            id="rate"
            type="text"
            inputMode="numeric"
            value={rateSats}
            onChange={(e) => setRateSats(e.target.value)}
          />
          {suggested &&
            SATS_RE.test(rateSats) &&
            formatEurIndicative(
              satsToMsat(BigInt(rateSats)),
              suggested.eurRate.satsPerEur,
              locale,
            ) && (
              <span className="hint" title={tCommon('indicativeNote')}>
                ≈{' '}
                {formatEurIndicative(
                  satsToMsat(BigInt(rateSats)),
                  suggested.eurRate.satsPerEur,
                  locale,
                )}
                /km
              </span>
            )}
        </div>

        {suggested && (
          <div className="alert alert-info stack-sm">
            <p className="small">
              {t('rateSuggestion', {
                eur: formatEurIndicative(suggested.msatPerKm, suggested.eurRate.satsPerEur, locale),
                sats: formatSats(suggested.msatPerKm, locale),
              })}
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRateSats((BigInt(suggested.msatPerKm) / 1000n).toString())}
            >
              {t('rateApply', { sats: formatSats(suggested.msatPerKm, locale) })}
            </button>
          </div>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('declaring') : t('submit')}
        </button>
      </form>
    </div>
  );
}
