'use client';

// Hub discovery (ADR-030): a navigable map whose viewport drives a bounded
// query (bbox + optional text search, distance-sorted from the map center)
// and a paginated list below — never the whole table, whatever the network
// grows to. Search flies the map to the results; "use my position" recenters
// on the browser's geolocation (asked only on tap, GDPR-minimal).

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { latLngBounds, type LatLngBoundsExpression } from 'leaflet';
import { searchHubs, type Hub } from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { HubCard } from '../../components/HubCard';

const HubsMap = dynamic(() => import('../../components/HubsMap'), {
  ssr: false,
  loading: () => <div className="trip-map" aria-hidden="true" />,
});

/** Whole-Italy start view: the first query is already viewport-bounded. */
const ITALY_BOUNDS: LatLngBoundsExpression = [
  [36.4, 6.5],
  [47.2, 18.6],
];
const ITALY_BBOX = '36.4,6.5,47.2,18.6';
const ITALY_CENTER = { lat: 42.5, lng: 12.5 };
const PAGE_SIZE = 20;

interface Viewport {
  bbox: string;
  center: { lat: number; lng: number };
  zoom: number;
}

export function HubsExplorer() {
  const t = useTranslations('hubs');
  const errorMessage = useApiErrorMessage();

  const [viewport, setViewport] = useState<Viewport>({
    bbox: ITALY_BBOX,
    center: ITALY_CENTER,
    zoom: 6,
  });
  const [query, setQuery] = useState('');
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [searchBounds, setSearchBounds] = useState<LatLngBoundsExpression | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One bounded query per settled viewport/search change. The map page is
  // capped at 200 markers (the API's max page) — clusters absorb the rest.
  const load = useCallback(
    (view: Viewport, q: string) => {
      searchHubs({
        bbox: view.bbox,
        near: `${view.center.lat},${view.center.lng}`,
        limit: 200,
        ...(q.trim() !== '' && { q: q.trim() }),
      })
        .then((res) => {
          setHubs(res.hubs);
          setTotal(res.total);
          setShown(PAGE_SIZE);
          setError(null);
        })
        .catch((err) => setError(errorMessage(err)));
    },
    // errorMessage is a fresh closure on every render — deliberately omitted
    // (house pattern, like RouteClient) so `load`'s identity stays stable.
    [],
  );

  // First bounded query on mount; every later one comes from the map's
  // moveend/zoomend or from a search submit.
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    load(viewport, query);
  }, [load, viewport, query]);

  const onViewport = useCallback(
    (view: Viewport) => {
      setViewport(view);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => load(view, query), 350);
    },
    [load, query],
  );

  // Search submits fly the map to the matches: query WITHOUT the viewport
  // filter, then let the map's moveend re-sync the viewport state.
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q === '') {
      load(viewport, '');
      return;
    }
    searchHubs({ q, near: `${viewport.center.lat},${viewport.center.lng}`, limit: 200 })
      .then((res) => {
        setHubs(res.hubs);
        setTotal(res.total);
        setShown(PAGE_SIZE);
        setError(null);
        if (res.hubs.length > 0) {
          setSearchBounds(
            latLngBounds(res.hubs.map((h) => [h.lat, h.lng] as [number, number])).pad(0.3),
          );
        }
      })
      .catch((err) => setError(errorMessage(err)));
  };

  const locate = () => {
    navigator.geolocation?.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      setSearchBounds(
        latLngBounds([
          [latitude - 0.35, longitude - 0.35],
          [latitude + 0.35, longitude + 0.35],
        ]),
      );
    });
  };

  const visible = hubs.slice(0, shown);

  return (
    <div className="stack">
      <form className="row" onSubmit={submitSearch}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
        />
        <button type="submit" className="btn btn-sm">
          {t('searchCta')}
        </button>
        <button type="button" className="btn btn-sm" onClick={locate}>
          {t('locateCta')}
        </button>
      </form>

      <HubsMap
        key={searchBounds ? JSON.stringify(searchBounds) : 'initial'}
        hubs={hubs.map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, name: h.name }))}
        initialBounds={searchBounds ?? ITALY_BOUNDS}
        zoom={viewport.zoom}
        onViewport={onViewport}
        onOpenHub={(id) => {
          window.location.href = `/hubs/${id}`;
        }}
        openLabel={t('openHub')}
      />

      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">{t('inArea', { count: total })}</p>
      {visible.length === 0 && !error && <p className="muted">{t('empty')}</p>}
      <div className="list-plain">
        {visible.map((hub) => (
          <div key={hub.id} className="stack-sm">
            <HubCard hub={hub} />
            <div className="row-between">
              <span className="muted small">
                {hub.distanceKm !== undefined && t('distanceLine', { km: hub.distanceKm.toFixed(1) })}
              </span>
              <Link className="btn btn-sm" href={`/hubs/${hub.id}`}>
                {t('openHub')}
              </Link>
            </div>
          </div>
        ))}
      </div>
      {shown < hubs.length && (
        <button type="button" className="btn" onClick={() => setShown((s) => s + PAGE_SIZE)}>
          {t('loadMore')}
        </button>
      )}
    </div>
  );
}
