'use client';

// Deposit-request dashboard (CLAUDE.md "Hub — dettagli"). One pinned,
// highlighted section collects EVERY request awaiting this hub's answer
// (punto 9): arrival deposit requests (ADR-029 — a carrier wants to drop a
// parcel here, 30-minute response window, accept/reject) first, ordered by
// response deadline, then origin drafts (accept only). Below, the stays
// currently reserved/hosted here with their storage deadlines and a door
// into the per-shipment operations page.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  depositAccept,
  depositReject,
  getMyHubRequests,
  getWallet,
  originAccept,
  type HubDashboard as HubDashboardData,
  type ProjectedEarning,
} from '../../lib/api/endpoints';
import { useHubs, hubNameFrom } from '../../lib/hub-lookup';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { formatDateTime } from '../../lib/format';
import { Amount } from '../../components/Amount';
import { Codename } from '../../components/Codename';
import { StatusBadge } from '../../components/StatusBadge';
import type { ShipmentState } from '../../lib/shipment-status';
import { VenuePhotoManager } from './VenuePhotoManager';

export function HubDashboard() {
  const t = useTranslations('hub');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();

  const [data, setData] = useState<HubDashboardData | null>(null);
  const [walletConnected, setWalletConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  // Arrival-request answer state (ADR-029): which leg is being answered and,
  // for a refusal, the reason being typed (documentation, ADR-012).
  const [answeringLegId, setAnsweringLegId] = useState<string | null>(null);
  const [rejectingLegId, setRejectingLegId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await getMyHubRequests());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    getWallet()
      .then((res) => setWalletConnected(res.wallet !== null))
      .catch(() => setWalletConnected(false));
  }, [load]);

  // Targeted lookups (ADR-030): only the hubs the dashboard rows mention.
  const hubs = useHubs([
    ...(data?.depositRequests.flatMap((r) => [r.fromHubId, r.destHubId]) ?? []),
    ...(data?.acceptRequests.map((r) => r.destHubId) ?? []),
    ...(data?.stays.map((s) => s.destHubId) ?? []),
  ]);
  const hubName = (hubId: string) => hubNameFrom(hubs, hubId);

  // Fase 2 punto 7: what the hub earns from a row — an exact figure where a leg
  // is priced, a "from–to" range where the split is not known yet.
  const renderEarning = (earning: ProjectedEarning, satsPerEur: string | null) =>
    earning.kind === 'exact' ? (
      <span className="small">
        {t('earningLabel')} <Amount msat={earning.msat} satsPerEur={satsPerEur} />
      </span>
    ) : (
      <span className="small">
        {t('earningEstimateLabel')} <Amount msat={earning.minMsat} satsPerEur={satsPerEur} />{' '}
        {t('earningRangeTo')} <Amount msat={earning.maxMsat} satsPerEur={satsPerEur} />
      </span>
    );

  const accept = async (shipmentId: string) => {
    setAcceptingId(shipmentId);
    setError(null);
    try {
      await originAccept(shipmentId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAcceptingId(null);
    }
  };

  // ADR-029: answer an ARRIVAL deposit request. Accept creates the holds
  // (the money phase starts only now); reject requires a reason and moves
  // zero money — the shipment simply returns to the board.
  const answerArrival = async (shipmentId: string, legId: string, reason: string | null) => {
    setAnsweringLegId(legId);
    setError(null);
    try {
      if (reason === null) await depositAccept(shipmentId, legId);
      else await depositReject(shipmentId, legId, reason);
      setRejectingLegId(null);
      setRejectReason('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAnsweringLegId(null);
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t('dashboardTitle')}</h1>
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          {t('refresh')}
        </button>
      </div>

      {walletConnected === false && (
        <div className="alert alert-warning stack-sm">
          <p>{t('needWallet')}</p>
          <Link className="btn" href="/wallet">
            {t('goWallet')}
          </Link>
        </div>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">{tCommon('loading')}</p>}

      {data && (
        <>
          {/* Punto 9: EVERY pending request in one pinned, highlighted card —
              arrival requests first (their 30-minute clock is running),
              origin drafts after. */}
          <section className="card card-highlight stack-sm">
            <h2>{t('acceptTitle')}</h2>
            <p className="muted small">{t('requestsIntro')}</p>
            {data.depositRequests.length === 0 && data.acceptRequests.length === 0 && (
              <p className="muted">{t('acceptEmpty')}</p>
            )}
            {data.depositRequests.length > 0 && (
              <ul className="list-plain">
                {data.depositRequests.map((req) => (
                  <li key={req.legId} className="stack-sm">
                    <div className="row-between">
                      <Codename value={req.codename} />
                      <span className="row">
                        <span className="badge badge-info">{t('arrivalBadge')}</span>
                        {req.undeclared && (
                          <span className="badge badge-warning">{t('undeclaredBadge')}</span>
                        )}
                      </span>
                    </div>
                    <strong>
                      {t('arrivalLine', {
                        from: hubName(req.fromHubId),
                        to: hubName(req.destHubId),
                      })}
                    </strong>
                    <p className="small muted">
                      {t('parcelLine', {
                        l: req.dims.lengthCm,
                        w: req.dims.widthCm,
                        h: req.dims.heightCm,
                        g: req.weightG,
                      })}
                      {' · '}
                      {t('storageLine', { days: req.maxStorageDays })}
                    </p>
                    {req.responseDeadlineAt && (
                      <p className="small">
                        <strong>
                          {t('respondBy', {
                            time: formatDateTime(req.responseDeadlineAt, locale),
                          })}
                        </strong>
                      </p>
                    )}
                    <div>{renderEarning(req.projectedEarning, req.eurRate.satsPerEur)}</div>
                    <div className="row-between">
                      <span className="small">
                        {t('bondLine')}{' '}
                        <Amount msat={req.custodyBondMsat} satsPerEur={req.eurRate.satsPerEur} />
                      </span>
                      <span className="row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={answeringLegId !== null}
                          onClick={() => {
                            setRejectingLegId(rejectingLegId === req.legId ? null : req.legId);
                            setRejectReason('');
                          }}
                        >
                          {t('rejectCta')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={answeringLegId !== null}
                          onClick={() => void answerArrival(req.shipmentId, req.legId, null)}
                        >
                          {answeringLegId === req.legId ? t('accepting') : t('acceptCta')}
                        </button>
                      </span>
                    </div>
                    {rejectingLegId === req.legId && (
                      <div className="stack-sm">
                        <label className="small" htmlFor={`reject-${req.legId}`}>
                          {t('rejectReasonLabel')}
                        </label>
                        <input
                          id={`reject-${req.legId}`}
                          type="text"
                          value={rejectReason}
                          maxLength={500}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder={t('rejectReasonPlaceholder')}
                        />
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={answeringLegId !== null || rejectReason.trim() === ''}
                          onClick={() =>
                            void answerArrival(req.shipmentId, req.legId, rejectReason.trim())
                          }
                        >
                          {answeringLegId === req.legId ? t('rejecting') : t('rejectConfirm')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.acceptRequests.length > 0 && (
              <ul className="list-plain">
                {data.acceptRequests.map((req) => (
                  <li key={req.shipmentId} className="stack-sm">
                    <div className="row-between">
                      <Codename value={req.codename} />
                      <span className="row">
                        <span className="badge badge-neutral">{t('originBadge')}</span>
                        {req.undeclared && (
                          <span className="badge badge-warning">{t('undeclaredBadge')}</span>
                        )}
                      </span>
                    </div>
                    <strong>{t('acceptDest', { hub: hubName(req.destHubId) })}</strong>
                    <p className="small muted">
                      {t('parcelLine', {
                        l: req.dims.lengthCm,
                        w: req.dims.widthCm,
                        h: req.dims.heightCm,
                        g: req.weightG,
                      })}
                      {' · '}
                      {t('storageLine', { days: req.maxStorageDays })}
                      {' · '}
                      {formatDateTime(req.createdAt, locale)}
                    </p>
                    <div>{renderEarning(req.projectedEarning, req.eurRate.satsPerEur)}</div>
                    <div className="row-between">
                      <span className="small">
                        {t('bondLine')}{' '}
                        <Amount msat={req.custodyBondMsat} satsPerEur={req.eurRate.satsPerEur} />
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={acceptingId !== null}
                        onClick={() => void accept(req.shipmentId)}
                      >
                        {acceptingId === req.shipmentId ? t('accepting') : t('acceptCta')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card stack-sm">
            <h2>{t('staysTitle')}</h2>
            <p className="muted small">{t('staysIntro')}</p>
            {data.stays.length === 0 ? (
              <p className="muted">{t('staysEmpty')}</p>
            ) : (
              <ul className="list-plain">
                {data.stays.map((stay) => (
                  <li key={stay.hubStayId} className="stack-sm">
                    <div className="row-between">
                      <Codename value={stay.codename} />
                      <span className="badge badge-neutral">{t(`stayStatus.${stay.status}`)}</span>
                    </div>
                    <div className="row-between">
                      <strong className="small">
                        {t('acceptDest', { hub: hubName(stay.destHubId) })}
                      </strong>
                      <StatusBadge status={stay.shipmentStatus.toUpperCase() as ShipmentState} />
                    </div>
                    <p className="small muted">
                      {stay.storageDeadlineAt
                        ? t('storageUntil', {
                            time: formatDateTime(stay.storageDeadlineAt, locale),
                          })
                        : t('storageNotStarted')}
                      {' · '}
                      {t('bondLine')}{' '}
                      <Amount msat={stay.custodyBondMsat} satsPerEur={stay.eurRate.satsPerEur} />
                    </p>
                    <div>{renderEarning(stay.projectedEarning, stay.eurRate.satsPerEur)}</div>
                    <Link className="btn btn-sm" href={`/hub/shipments/${stay.shipmentId}`}>
                      {t('openOps')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <VenuePhotoManager hubId={data.hubId} />
        </>
      )}
    </div>
  );
}
