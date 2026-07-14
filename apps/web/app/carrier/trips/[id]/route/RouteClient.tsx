'use client';

// Trip route view (ADR-015, UI part): Leaflet map with the stops in the
// order computed by GET /trips/:id/route — optionally previewing one board
// shipment — the over-cap stops as a plain list, and the "Apri in Google
// Maps" button that uses the URL the ENDPOINT built (our visit order; no
// data reaches Google before the explicit click).

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_ROUTE_WAYPOINTS } from '@mercurio/shared';
import { getTripRoute, type TripRoute } from '../../../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../../../lib/api-error-message';
import { useSession } from '../../../../../lib/session';

// Leaflet touches `window` at import time: client-only chunk.
const TripMap = dynamic(() => import('../../../../../components/TripMap'), {
  ssr: false,
  loading: () => <div className="trip-map" aria-hidden="true" />,
});

export function RouteClient({
  tripId,
  preview,
}: {
  tripId: string;
  preview?: { previewShipmentId: string; previewDropHubId: string };
}) {
  const t = useTranslations('route');
  const tCommon = useTranslations('common');
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [route, setRoute] = useState<TripRoute | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading || !user) return;
    getTripRoute(tripId, preview)
      .then((res) => {
        setRoute(res);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [sessionLoading, user, tripId, preview?.previewShipmentId, preview?.previewDropHubId]);

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
  if (error) {
    return (
      <div className="card stack-sm">
        <h1>{t('title')}</h1>
        <p className="field-error" role="alert">
          {error}
        </p>
        <Link className="btn" href={`/carrier/trips/${tripId}`}>
          {t('backToBoard')}
        </Link>
      </div>
    );
  }
  if (!route) return <p className="muted">{t('loading')}</p>;

  const stopLine = (stop: TripRoute['stops'][number], index: number | null) => (
    <li key={`${stop.hubId}-${stop.kind}-${index}`} className="row">
      {index !== null && <strong>{index + 1}.</strong>}
      <span>
        {stop.kind === 'pickup' ? t('pickup') : t('drop')} — {stop.hubName}
      </span>
      {stop.preview && <span className="badge badge-info">{t('previewBadge')}</span>}
    </li>
  );

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t('title')}</h1>
        <Link className="btn btn-sm" href={`/carrier/trips/${tripId}`}>
          {t('backToBoard')}
        </Link>
      </div>
      <p className="muted">{t('subtitle')}</p>

      <TripMap
        origin={route.origin}
        destination={route.destination}
        stops={route.stops}
        labels={{
          origin: t('origin'),
          destination: t('destination'),
          pickup: t('pickup'),
          drop: t('drop'),
          preview: t('previewBadge'),
        }}
      />

      <div className="stack-sm">
        <a
          className="btn btn-primary"
          href={route.googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer external"
        >
          {t('openGoogle')}
        </a>
        <p className="hint">{t('googleNote')}</p>
      </div>

      <section className="card">
        <h2>{t('stopsTitle')}</h2>
        {route.stops.length === 0 ? (
          <p className="muted">{t('stopsEmpty')}</p>
        ) : (
          <ol className="list-plain">{route.stops.map((s, i) => stopLine(s, i))}</ol>
        )}
      </section>

      {route.unroutedStops.length > 0 && (
        <section className="card">
          <h2>{t('unroutedTitle')}</h2>
          <p className="muted small">{t('unroutedBody', { max: MAX_ROUTE_WAYPOINTS })}</p>
          <ul className="list-plain">{route.unroutedStops.map((s) => stopLine(s, null))}</ul>
        </section>
      )}
    </div>
  );
}
