'use client';

// Shipments waiting at this hub (ADR-030 "reverse trip planning"): a carrier
// browsing the network sees what they could pick up HERE, with the indicative
// gross ceiling (remaining pool + delivery bonus) in sats + EUR at each
// shipment's frozen rate — then declares the trip that passes by. Requires a
// session: the shelf inventory is for participants, not the open web.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  getHubWaitingShipments,
  type HubWaitingShipment,
} from '../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../lib/api-error-message';
import { useSession } from '../../../lib/session';
import { formatKm } from '../../../lib/format';
import { Amount } from '../../../components/Amount';
import { Codename } from '../../../components/Codename';

export function WaitingShipments({ hubId, hubName }: { hubId: string; hubName: string }) {
  const t = useTranslations('hubs');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [shipments, setShipments] = useState<HubWaitingShipment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading || !user) return;
    getHubWaitingShipments(hubId)
      .then((res) => {
        setShipments(res.shipments);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
    // errorMessage is a fresh closure on every render (house pattern:
    // deliberately omitted from the deps, like RouteClient) — including it
    // would refetch in a loop whenever an error renders.
  }, [sessionLoading, user, hubId]);

  return (
    <section className="card stack-sm">
      <h2>{t('waitingTitle', { hub: hubName })}</h2>
      <p className="muted small">{t('waitingIntro')}</p>

      {sessionLoading && <p className="muted">{tCommon('loading')}</p>}
      {!sessionLoading && !user && (
        <div className="stack-sm">
          <p className="muted">{tCommon('loginRequired')}</p>
          <Link className="btn btn-sm" href="/login">
            {tCommon('loginCta')}
          </Link>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {user && shipments !== null && shipments.length === 0 && (
        <p className="muted">{t('waitingEmpty')}</p>
      )}
      {user && shipments !== null && shipments.length > 0 && (
        <>
          <ul className="list-plain">
            {shipments.map((s) => (
              <li key={s.shipmentId} className="stack-sm">
                <div className="row-between">
                  <Codename value={s.codename} />
                  {s.undeclared && (
                    <span className="badge badge-warning">{t('waitingUndeclared')}</span>
                  )}
                </div>
                <strong>
                  {t('waitingDest', { hub: s.destHubName, km: formatKm(s.remainingKm, locale) })}
                </strong>
                <p className="small muted">
                  {t('waitingParcel', {
                    l: s.dims.lengthCm,
                    w: s.dims.widthCm,
                    h: s.dims.heightCm,
                    g: s.weightG,
                  })}
                </p>
                <p className="small">
                  {t('waitingUpTo')}{' '}
                  <Amount msat={s.maxGrossMsat} satsPerEur={s.eurRate.satsPerEur} />
                  {' · '}
                  {t('waitingBond')}{' '}
                  <Amount msat={s.custodyBondMsat} satsPerEur={s.eurRate.satsPerEur} />
                </p>
              </li>
            ))}
          </ul>
          {/* The reverse-planning handoff: declare the trip that passes here,
              the board then shows the REAL frozen numbers. */}
          <Link className="btn btn-primary" href="/carrier">
            {t('waitingDeclareTrip')}
          </Link>
          <p className="hint">{t('waitingCeilingNote')}</p>
        </>
      )}
    </section>
  );
}
