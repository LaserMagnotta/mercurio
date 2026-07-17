'use client';

// The recipient's page (ADR-016): tracking plus the early-pickup claim.
// The claim token from the email is the bearer credential — it is pasted
// here, sent in the POST body and NEVER placed in a URL. Before claiming,
// the recipient is not a shipment participant (GET /shipments/:id is 404):
// the page then shows the claim form; after a successful claim they are a
// participant and the page becomes their live tracking view. All claim
// amounts are frozen by the API — this page renders, it never computes.

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ApiError } from '../../../lib/api/client';
import {
  getHubs,
  getShipment,
  getShipmentPhotos,
  getWallet,
  recipientClaim,
  type ClaimCreated,
  type Hub,
  type ShipmentDetail,
} from '../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../lib/api-error-message';
import { useSession } from '../../../lib/session';
import { formatDateTime } from '../../../lib/format';
import {
  CUSTODY_EVENT_TYPES,
  custodyEventPhotoHashes,
  statusDescriptionKey,
} from '../../../lib/shipment-status';
import { Amount } from '../../../components/Amount';
import { PhotoStrip } from '../../../components/PhotoStrip';
import { QrCode } from '../../../components/QrCode';
import { StatusBadge } from '../../../components/StatusBadge';

const KNOWN_CUSTODY = new Set<string>(CUSTODY_EVENT_TYPES);

/** My last claim's fate, read from the custody chain (the detail DTO has no
 *  claim rows; the chain's claim_requested/funded/expired events are the
 *  public record — ADR-016 precisazione 4). */
type ClaimPhase = 'none' | 'pending' | 'expired';

function lastClaimPhase(detail: ShipmentDetail, userId: string): ClaimPhase {
  let phase: ClaimPhase = 'none';
  let claimId: string | null = null;
  for (const event of detail.custodyChain) {
    const payload = event.payload as { claimId?: unknown; reason?: unknown };
    if (event.type === 'claim_requested' && event.actorUserId === userId) {
      claimId = typeof payload.claimId === 'string' ? payload.claimId : null;
      phase = 'pending';
    } else if (phase === 'pending' && event.type === 'funded' && payload.claimId === claimId) {
      phase = 'none'; // funded → the shipment status (CLAIMED) tells the story
    } else if (
      phase === 'pending' &&
      event.type === 'expired' &&
      payload.reason === 'claim_funding'
    ) {
      phase = 'expired';
    }
  }
  return phase;
}

export function TrackClient({ id }: { id: string }) {
  const t = useTranslations('track');
  const tCommon = useTranslations('common');
  const tStatuses = useTranslations('statuses');
  const tCustody = useTranslations('custody');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [availablePhotos, setAvailablePhotos] = useState<ReadonlySet<string>>(new Set());
  const [isParticipant, setIsParticipant] = useState<boolean | null>(null);
  const [walletConnected, setWalletConnected] = useState<boolean | null>(null);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [token, setToken] = useState('');
  const [showTokenQr, setShowTokenQr] = useState(false);
  const [claim, setClaim] = useState<ClaimCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getShipment(id));
      setIsParticipant(true);
      // Photos become visible with the claim (ADR-020 §4): before it this
      // very request is a 404, exactly like the detail above.
      getShipmentPhotos(id)
        .then((res) => setAvailablePhotos(new Set(res.photos.map((p) => p.sha256))))
        .catch(() => setAvailablePhotos(new Set()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setIsParticipant(false);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [id]);

  useEffect(() => {
    if (sessionLoading || !user) return;
    void load();
    getWallet()
      .then((res) => setWalletConnected(res.wallet !== null))
      .catch(() => setWalletConnected(false));
  }, [sessionLoading, user, load]);

  useEffect(() => {
    getHubs()
      .then((res) => setHubs(res.hubs))
      .catch(() => setHubs([]));
  }, []);

  if (sessionLoading) return <p className="muted">{tCommon('loading')}</p>;

  if (!user) {
    return (
      <div className="stack">
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
        <div className="card stack-sm">
          <p>{t('loginNote')}</p>
          <Link className="btn btn-primary" href="/login">
            {tCommon('loginCta')}
          </Link>
        </div>
      </div>
    );
  }

  const hubName = (hubId: string | null) =>
    hubId ? (hubs.find((h) => h.id === hubId)?.name ?? `${hubId.slice(0, 8)}…`) : '—';

  const submitClaim = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    recipientClaim(id, token.trim())
      .then(async (created) => {
        setClaim(created);
        await load();
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const claimForm = (
    <form onSubmit={submitClaim} className="stack-sm">
      {walletConnected === false && (
        <div className="alert alert-warning stack-sm">
          <p>{t('needWallet')}</p>
          <Link className="btn" href="/wallet">
            {t('goWallet')}
          </Link>
        </div>
      )}
      <div className="field">
        <label htmlFor="track-token">{t('tokenLabel')}</label>
        <input
          id="track-token"
          type="text"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <span className="hint">{t('tokenHint')}</span>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy || token.trim() === '' || walletConnected === false}
      >
        {busy ? t('claiming') : t('claimCta')}
      </button>
    </form>
  );

  // Not a participant yet: the claim form is the whole page.
  if (isParticipant === false) {
    return (
      <div className="stack">
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
        <section className="card stack-sm">
          <h2>{t('notYetTitle')}</h2>
          <p className="muted small">{t('notYetBody')}</p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {claimForm}
        </section>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="stack">
        <h1>{t('title')}</h1>
        {error ? <p className="field-error">{error}</p> : <p className="muted">{tCommon('loading')}</p>}
      </div>
    );
  }

  const rate = detail.eurRate.satsPerEur;
  const phase = lastClaimPhase(detail, user.id);

  return (
    <div className="stack">
      <section>
        <div className="row-between">
          <h1>{t('title')}</h1>
          <span className="row">
            <StatusBadge status={detail.status} />
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              {t('refresh')}
            </button>
          </span>
        </div>
        <p className="muted">{tStatuses(statusDescriptionKey(detail.status))}</p>
        {detail.currentHubId && (
          <p>
            <strong>{t('parcelAt', { hub: hubName(detail.currentHubId) })}</strong>
          </p>
        )}
      </section>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {claim && (
        <section className="card stack-sm">
          <h2>{t('claimedTitle')}</h2>
          <dl className="kv">
            <dt>{t('youCollect')}</dt>
            <dd>
              <Amount msat={claim.claimPaymentMsat} satsPerEur={rate} pending size="lg" />
            </dd>
          </dl>
          <p className="hint">
            {t('fundingBy', { time: formatDateTime(claim.fundingDeadlineAt, locale) })}
          </p>
        </section>
      )}

      {detail.status === 'CLAIMED' && (
        <section className="card stack-sm">
          <p className="alert alert-info">{t('claimActive')}</p>
          <button
            type="button"
            className="btn"
            onClick={() => setShowTokenQr(!showTokenQr)}
          >
            {t('showToken')}
          </button>
          {showTokenQr &&
            (token.trim() !== '' ? (
              <div className="stack-sm">
                <QrCode value={token.trim()} label={t('tokenQrLabel')} />
                <p className="hint">{t('tokenQrHint')}</p>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="track-token-qr">{t('tokenLabel')}</label>
                <input
                  id="track-token-qr"
                  type="text"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <span className="hint">{t('tokenHint')}</span>
              </div>
            ))}
        </section>
      )}

      {detail.status === 'DELIVERED' && <p className="alert alert-success">{t('delivered')}</p>}

      {detail.status === 'AT_HUB' && !claim && (
        <section className="card stack-sm">
          <h2>{t('notYetTitle')}</h2>
          {phase === 'pending' && <p className="alert alert-info">{t('claimPending')}</p>}
          {phase === 'expired' && <p className="alert alert-warning">{t('claimExpired')}</p>}
          {phase !== 'pending' && (
            <>
              <p className="muted small">{t('notYetBody')}</p>
              {claimForm}
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>{t('historyTitle')}</h2>
        <ol className="timeline">
          {detail.custodyChain.map((event, i) => {
            const eventHashes = custodyEventPhotoHashes(event.payload);
            return (
              <li key={`${event.hash}-${i}`}>
                <div>{KNOWN_CUSTODY.has(event.type) ? tCustody(event.type) : event.type}</div>
                <div className="muted small">{formatDateTime(event.createdAt, locale)}</div>
                {eventHashes.length > 0 && (
                  <PhotoStrip
                    shipmentId={detail.id}
                    hashes={eventHashes}
                    available={availablePhotos}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
