'use client';

// Shipment detail & tracking: status with plain-language copy, per-leg
// amounts (all straight from the API — the page renders figures, it never
// derives them), pending holds in the Daily-spending-wallet idiom, custody
// chain, participant ratings (ADR-017) and the sender's boost/reroute/cancel
// where the state admits them (the API stays the judge).

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  boostShipment,
  cancelShipment,
  getHubs,
  getShipment,
  getShipmentPhotos,
  rerouteShipment,
  type Hub,
  type ShipmentDetail,
} from '../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../lib/api-error-message';
import { useSession } from '../../../lib/session';
import { formatDateTime, formatKm, formatSatsPerEur, satsToMsat } from '../../../lib/format';
import {
  CUSTODY_EVENT_TYPES,
  SENDER_ACTIONS,
  custodyEventPhotoHashes,
  statusDescriptionKey,
} from '../../../lib/shipment-status';
import { Amount } from '../../../components/Amount';
import { Codename } from '../../../components/Codename';
import { StatusBadge } from '../../../components/StatusBadge';
import { RatingStars } from '../../../components/RatingStars';
import { QrCode } from '../../../components/QrCode';
import { PhotoStrip } from '../../../components/PhotoStrip';
import { CarrierActions } from './CarrierActions';
import { ReviewsSection } from './ReviewsSection';

const SATS_RE = /^\d{1,15}$/;
const KNOWN_CUSTODY = new Set<string>(CUSTODY_EVENT_TYPES);

type ActionPanel = 'boost' | 'reroute' | 'cancel' | null;

export function ShipmentClient({
  id,
  justCreated,
  photosFailed = 0,
}: {
  id: string;
  justCreated: boolean;
  /** Creation photos whose byte upload failed right after create (ADR-022):
   *  the certification stands, the banner just says so. */
  photosFailed?: number;
}) {
  const t = useTranslations('shipment');
  const tStatuses = useTranslations('statuses');
  const tCustody = useTranslations('custody');
  const tRoles = useTranslations('roles');
  const tCommon = useTranslations('common');
  const tPhotos = useTranslations('photos');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [availablePhotos, setAvailablePhotos] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(justCreated);
  const [qrOrigin, setQrOrigin] = useState('');
  const [panel, setPanel] = useState<ActionPanel>(null);
  const [boostSats, setBoostSats] = useState('');
  const [rerouteDest, setRerouteDest] = useState('');
  const [rerouteEmail, setRerouteEmail] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getShipment(id));
      setLoadError(null);
      // Best-effort (ADR-020): the chain shows hashes regardless; only the
      // thumbnails need this listing.
      getShipmentPhotos(id)
        .then((res) => setAvailablePhotos(new Set(res.photos.map((p) => p.sha256))))
        .catch(() => setAvailablePhotos(new Set()));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    if (!sessionLoading && user) void load();
  }, [sessionLoading, user, load]);

  useEffect(() => {
    getHubs()
      .then((res) => setHubs(res.hubs))
      .catch(() => setHubs([]));
    setQrOrigin(window.location.origin);
  }, []);

  const hubName = useMemo(() => {
    const byId = new Map(hubs.map((h) => [h.id, h.name]));
    return (hubId: string | null) => (hubId ? (byId.get(hubId) ?? `${hubId.slice(0, 8)}…`) : '—');
  }, [hubs]);

  if (sessionLoading) return <p className="muted">{tCommon('loading')}</p>;
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
  if (loadError) {
    return (
      <div className="card stack-sm">
        <h1>{t('title')}</h1>
        <p className="field-error">{t('notFound')}</p>
        <p className="muted small">{loadError}</p>
      </div>
    );
  }
  if (!detail) return <p className="muted">{tCommon('loading')}</p>;

  const isSender = detail.senderId === user.id;
  const rate = detail.eurRate.satsPerEur;
  const offeredActions = isSender ? SENDER_ACTIONS[detail.status] : [];
  const pendingLeg = detail.legs.find((l) => l.status === 'pending_funding');
  const bookedLeg = detail.legs.find((l) => l.status === 'booked');
  const holdLeg = pendingLeg ?? bookedLeg;

  const runAction = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setActionDone(false);
    setBusy(true);
    try {
      await fn();
      setActionDone(true);
      setPanel(null);
      setBoostSats('');
      setRerouteDest('');
      setRerouteEmail('');
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitBoost = (e: FormEvent) => {
    e.preventDefault();
    if (!SATS_RE.test(boostSats)) {
      setActionError(t('rerouteNeedChange'));
      return;
    }
    void runAction(() =>
      boostShipment(detail.id, satsToMsat(BigInt(boostSats)), crypto.randomUUID()),
    );
  };

  const submitReroute = (e: FormEvent) => {
    e.preventDefault();
    if (!rerouteDest && rerouteEmail.trim() === '') {
      setActionError(t('rerouteNeedChange'));
      return;
    }
    void runAction(() =>
      rerouteShipment(detail.id, {
        ...(rerouteDest && { newDestHubId: rerouteDest }),
        ...(rerouteEmail.trim() !== '' && { newRecipientEmail: rerouteEmail.trim() }),
      }),
    );
  };

  return (
    <div className="stack">
      {justCreated && (
        <div className="alert alert-success">
          <strong>{t('createdTitle')}</strong>{' '}
          {detail.status === 'DRAFT' ? t('createdNotAccepted') : t('createdAccepted')}
        </div>
      )}
      {justCreated && photosFailed > 0 && (
        <div className="alert alert-warning" role="status">
          {tPhotos('uploadFailed', { failed: photosFailed })}
        </div>
      )}

      <section>
        <div className="row-between">
          <div>
            <p className="muted">{t('title')}</p>
            <h1>
              <Codename value={detail.codename} className="codename-lg" />
            </h1>
          </div>
          <StatusBadge status={detail.status} />
        </div>
        <p className="muted">{tStatuses(statusDescriptionKey(detail.status))}</p>
        <p>
          <strong>
            {t('fromTo', {
              origin: hubName(detail.originHubId),
              dest: hubName(detail.destHubId),
            })}
          </strong>
        </p>
        {detail.currentHubId && (
          <p className="small">{t('currentHub', { hub: hubName(detail.currentHubId) })}</p>
        )}
        {detail.remainingKm !== null && (
          <p className="small muted">
            {t('remaining', {
              km: formatKm(detail.remainingKm, locale),
              total: formatKm(detail.distanceKm, locale),
            })}
          </p>
        )}
      </section>

      {isSender && detail.qrToken && (
        <section className="card stack-sm">
          <div className="row-between">
            <h2>{t('qrTitle')}</h2>
            <button
              type="button"
              className="btn btn-sm no-print"
              onClick={() => setShowQr(!showQr)}
            >
              {showQr ? t('qrHide') : t('qrShow')}
            </button>
          </div>
          {showQr && qrOrigin && (
            <div className="print-area stack-sm">
              <QrCode value={`${qrOrigin}/p/${detail.qrToken}`} label={t('qrTitle')} />
              <p className="muted small">{t('qrInstructions')}</p>
              <button
                type="button"
                className="btn btn-primary no-print"
                onClick={() => window.print()}
              >
                {tCommon('print')}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>{t('amountsTitle')}</h2>
        <dl className="kv">
          <dt>{t('offer')}</dt>
          <dd>
            <Amount msat={detail.offerMsat} satsPerEur={rate} />
          </dd>
          <dt>{t('pool')}</dt>
          <dd>
            <Amount msat={detail.remainingPoolMsat} satsPerEur={rate} />
          </dd>
          <dt>{t('bond')}</dt>
          <dd>
            <Amount msat={detail.custodyBondMsat} satsPerEur={rate} />
          </dd>
        </dl>
        <p className="hint">{t('poolHint')}</p>
        <p className="hint">
          {t('rateLine', {
            rate: formatSatsPerEur(detail.eurRate.satsPerEur),
            source: detail.eurRate.source,
          })}
        </p>
      </section>

      {holdLeg && (
        <section className="card">
          <h2>{t('holdsTitle')}</h2>
          <dl className="kv">
            <dt>{t('legPayment', { seq: holdLeg.seq + 1 })}</dt>
            <dd>
              <Amount
                msat={holdLeg.grossMsat}
                satsPerEur={rate}
                pending={holdLeg.status === 'pending_funding'}
              />
            </dd>
            {holdLeg.finalizationBonusMsat !== '0' && (
              <>
                <dt>{t('legBonus')}</dt>
                <dd>
                  <Amount
                    msat={holdLeg.finalizationBonusMsat}
                    satsPerEur={rate}
                    pending={holdLeg.status === 'pending_funding'}
                  />
                </dd>
              </>
            )}
            <dt>{t('carrierBond')}</dt>
            <dd>
              <Amount
                msat={detail.custodyBondMsat}
                satsPerEur={rate}
                pending={holdLeg.status === 'pending_funding'}
              />
            </dd>
          </dl>
          <p className="hint">
            {holdLeg.status === 'pending_funding' ? t('holdPending') : t('holdHeld')}
            {holdLeg.fundingDeadlineAt &&
              holdLeg.status === 'pending_funding' &&
              ` — ${t('legFundingBy', { time: formatDateTime(holdLeg.fundingDeadlineAt, locale) })}`}
          </p>
        </section>
      )}

      <section className="card">
        <h2>{t('legsTitle')}</h2>
        {detail.legs.length === 0 ? (
          <p className="muted">{t('legsEmpty')}</p>
        ) : (
          <ul className="list-plain">
            {detail.legs.map((leg) => (
              <li key={leg.id} className="stack-sm">
                <div className="row-between">
                  <strong>
                    {t('legLine', { from: hubName(leg.fromHubId), to: hubName(leg.toHubId) })}
                  </strong>
                  <span className="badge badge-neutral">{t(`legStatus.${leg.status}`)}</span>
                </div>
                <dl className="kv small">
                  <dt>{t('legNet')}</dt>
                  <dd>
                    <Amount msat={leg.netMsat} satsPerEur={rate} />
                  </dd>
                  <dt>{t('legGross')}</dt>
                  <dd>
                    <Amount msat={leg.grossMsat} satsPerEur={rate} />
                  </dd>
                  <dt>{t('legFees')}</dt>
                  <dd>
                    <Amount msat={leg.depHubFeeMsat} satsPerEur={rate} /> +{' '}
                    <Amount msat={leg.arrHubFeeMsat} satsPerEur={rate} />
                  </dd>
                  {leg.finalizationBonusMsat !== '0' && (
                    <>
                      <dt>{t('legBonus')}</dt>
                      <dd>
                        <Amount msat={leg.finalizationBonusMsat} satsPerEur={rate} />
                      </dd>
                    </>
                  )}
                </dl>
                <p className="muted small">
                  {t('legProgress', { km: formatKm(leg.progressKm, locale) })}
                  {leg.pickupDeadlineAt &&
                    ` · ${t('legPickupBy', { time: formatDateTime(leg.pickupDeadlineAt, locale) })}`}
                  {leg.transitDeadlineAt &&
                    ` · ${t('legTransitBy', { time: formatDateTime(leg.transitDeadlineAt, locale) })}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>{t('custodyTitle')}</h2>
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

      <CarrierActions detail={detail} userId={user.id} onDone={load} />

      <section className="card">
        <h2>{t('ratingsTitle')}</h2>
        <ul className="list-plain">
          {detail.ratings.map((p) => (
            <li key={`${p.userId}-${p.role}`} className="row-between">
              <span>
                <Link href={`/users/${p.userId}`}>{tRoles(p.role)}</Link>
                {p.hubId && ` — ${hubName(p.hubId)}`}
              </span>
              <RatingStars rating={{ averageStars: p.averageStars, reviewCount: p.reviewCount }} />
            </li>
          ))}
        </ul>
      </section>

      <ReviewsSection detail={detail} userId={user.id} hubName={hubName} />

      {offeredActions.length > 0 && (
        <section className="card stack-sm no-print">
          <h2>{t('actionsTitle')}</h2>
          {actionDone && (
            <p className="alert alert-success" role="status">
              {t('actionDone')}
            </p>
          )}
          {actionError && (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="row">
            {offeredActions.includes('boost') && (
              <button
                type="button"
                className="btn"
                onClick={() => setPanel(panel === 'boost' ? null : 'boost')}
              >
                {t('boostCta')}
              </button>
            )}
            {offeredActions.includes('reroute') && (
              <button
                type="button"
                className="btn"
                onClick={() => setPanel(panel === 'reroute' ? null : 'reroute')}
              >
                {t('rerouteCta')}
              </button>
            )}
            {offeredActions.includes('cancel') && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}
              >
                {t('cancelCta')}
              </button>
            )}
          </div>

          {panel === 'boost' && (
            <form onSubmit={submitBoost} className="stack-sm">
              <div className="field">
                <label htmlFor="boost">{t('boostLabel')}</label>
                <input
                  id="boost"
                  type="text"
                  inputMode="numeric"
                  value={boostSats}
                  onChange={(e) => setBoostSats(e.target.value)}
                />
                <span className="hint">{t('boostHint')}</span>
              </div>
              <button className="btn btn-primary" disabled={busy || !SATS_RE.test(boostSats)}>
                {t('boostSubmit')}
              </button>
            </form>
          )}

          {panel === 'reroute' && (
            <form onSubmit={submitReroute} className="stack-sm">
              <div className="field">
                <label htmlFor="reroute-dest">{t('rerouteNewDest')}</label>
                <select
                  id="reroute-dest"
                  value={rerouteDest}
                  onChange={(e) => setRerouteDest(e.target.value)}
                >
                  <option value="">{t('rerouteKeepDest')}</option>
                  {hubs
                    .filter((h) => h.id !== detail.destHubId)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} — {h.address}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="reroute-email">{t('rerouteNewRecipient')}</label>
                <input
                  id="reroute-email"
                  type="email"
                  value={rerouteEmail}
                  onChange={(e) => setRerouteEmail(e.target.value)}
                />
                <span className="hint">{t('rerouteHint')}</span>
              </div>
              <button className="btn btn-primary" disabled={busy}>
                {t('rerouteSubmit')}
              </button>
            </form>
          )}

          {panel === 'cancel' && (
            <div className="stack-sm">
              <p>{t('cancelBody')}</p>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void runAction(() => cancelShipment(detail.id))}
              >
                {t('cancelSubmit')}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
