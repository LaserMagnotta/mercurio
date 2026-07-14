'use client';

// Deposit-request dashboard (CLAUDE.md "Hub — dettagli"): shipments waiting
// for this hub's MANUAL acceptance (auto_accept hubs never see one) and the
// stays currently reserved/hosted here, each with its storage deadline and
// a door into the per-shipment operations page.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  getHubs,
  getMyHubRequests,
  getWallet,
  originAccept,
  type Hub,
  type HubDashboard as HubDashboardData,
} from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { formatDateTime } from '../../lib/format';
import { Amount } from '../../components/Amount';
import { StatusBadge } from '../../components/StatusBadge';
import type { ShipmentState } from '../../lib/shipment-status';

export function HubDashboard() {
  const t = useTranslations('hub');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();

  const [data, setData] = useState<HubDashboardData | null>(null);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [walletConnected, setWalletConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

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
    getHubs()
      .then((res) => setHubs(res.hubs))
      .catch(() => setHubs([]));
    getWallet()
      .then((res) => setWalletConnected(res.wallet !== null))
      .catch(() => setWalletConnected(false));
  }, [load]);

  const hubName = (hubId: string) =>
    hubs.find((h) => h.id === hubId)?.name ?? `${hubId.slice(0, 8)}…`;

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
          <section className="card stack-sm">
            <h2>{t('acceptTitle')}</h2>
            <p className="muted small">{t('acceptIntro')}</p>
            {data.acceptRequests.length === 0 ? (
              <p className="muted">{t('acceptEmpty')}</p>
            ) : (
              <ul className="list-plain">
                {data.acceptRequests.map((req) => (
                  <li key={req.shipmentId} className="stack-sm">
                    <div className="row-between">
                      <strong>{t('acceptDest', { hub: hubName(req.destHubId) })}</strong>
                      {req.undeclared && (
                        <span className="badge badge-warning">{t('undeclaredBadge')}</span>
                      )}
                    </div>
                    <p className="small muted">
                      {t('parcelLine', {
                        l: req.dims.lengthCm,
                        w: req.dims.widthCm,
                        h: req.dims.heightCm,
                        g: req.weightG,
                      })}
                      {' · '}
                      {t('storageLine', { hours: req.maxStorageHours })}
                      {' · '}
                      {formatDateTime(req.createdAt, locale)}
                    </p>
                    <div className="row-between">
                      <span className="small">
                        {t('bondLine')} <Amount msat={req.custodyBondMsat} />
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
                      <StatusBadge
                        status={stay.shipmentStatus.toUpperCase() as ShipmentState}
                      />
                      <span className="badge badge-neutral">{t(`stayStatus.${stay.status}`)}</span>
                    </div>
                    <p className="small">
                      <strong>{t('acceptDest', { hub: hubName(stay.destHubId) })}</strong>
                    </p>
                    <p className="small muted">
                      {stay.storageDeadlineAt
                        ? t('storageUntil', {
                            time: formatDateTime(stay.storageDeadlineAt, locale),
                          })
                        : t('storageNotStarted')}
                      {' · '}
                      {t('bondLine')} <Amount msat={stay.custodyBondMsat} />
                    </p>
                    <Link className="btn btn-sm" href={`/hub/shipments/${stay.shipmentId}`}>
                      {t('openOps')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
