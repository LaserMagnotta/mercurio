'use client';

// Navigable hub discovery map (ADR-030): Leaflet + OSM tiles like TripMap,
// but the VIEWPORT drives the data — every pan/zoom reports the new bbox to
// the parent, which re-queries the API (bounded page, never the full table).
// Markers cluster on a screen-space grid (lib/map-cluster) so 10k hubs render
// as a handful of counted dots until the user zooms in.
//
// Loaded with next/dynamic ssr:false — Leaflet touches `window` at import.

import { useMemo } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMapEvents } from 'react-leaflet';
import { divIcon, type LatLngBoundsExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { clusterPoints, type ClusterPoint } from '../lib/map-cluster';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface HubMapPoint extends ClusterPoint {
  name: string;
}

export interface HubsMapProps {
  hubs: HubMapPoint[];
  /** Initial view: whole-country bounds until the user moves the map. */
  initialBounds: LatLngBoundsExpression;
  zoom: number;
  onViewport: (view: { bbox: string; center: { lat: number; lng: number }; zoom: number }) => void;
  onOpenHub: (hubId: string) => void;
  openLabel: string;
}

function ViewportReporter({ onViewport }: { onViewport: HubsMapProps['onViewport'] }) {
  const report = (map: ReturnType<typeof useMapEvents>) => {
    const b = map.getBounds();
    const c = map.getCenter();
    onViewport({
      bbox: `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`,
      center: { lat: c.lat, lng: c.lng },
      zoom: map.getZoom(),
    });
  };
  const map = useMapEvents({
    moveend: () => report(map),
    zoomend: () => report(map),
  });
  return null;
}

function clusterIcon(count: number) {
  return divIcon({
    html: `<span class="map-marker map-marker-cluster">${count}</span>`,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function hubIcon() {
  return divIcon({
    html: '<span class="map-marker map-marker-hub">●</span>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export default function HubsMap({
  hubs,
  initialBounds,
  zoom,
  onViewport,
  onOpenHub,
  openLabel,
}: HubsMapProps) {
  const clusters = useMemo(() => clusterPoints(hubs, zoom), [hubs, zoom]);

  return (
    <MapContainer bounds={initialBounds} className="trip-map" scrollWheelZoom>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} />
      <ViewportReporter onViewport={onViewport} />
      {clusters.map((cluster) =>
        cluster.points.length === 1 ? (
          <Marker
            key={cluster.points[0]!.id}
            position={[cluster.lat, cluster.lng]}
            icon={hubIcon()}
          >
            <Popup>
              <span className="stack-sm">
                <strong>{cluster.points[0]!.name}</strong>{' '}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenHub(cluster.points[0]!.id)}
                >
                  {openLabel}
                </button>
              </span>
            </Popup>
          </Marker>
        ) : (
          <ClusterMarker
            key={`c-${cluster.lat.toFixed(5)}-${cluster.lng.toFixed(5)}`}
            lat={cluster.lat}
            lng={cluster.lng}
            count={cluster.points.length}
          />
        ),
      )}
    </MapContainer>
  );
}

/** A counted cluster dot: clicking zooms two levels into its center — the
 *  grid shrinks with zoom, so members split apart without any plugin. */
function ClusterMarker({ lat, lng, count }: { lat: number; lng: number; count: number }) {
  const map = useMapEvents({});
  return (
    <Marker
      position={[lat, lng]}
      icon={clusterIcon(count)}
      eventHandlers={{ click: () => map.setView([lat, lng], map.getZoom() + 2) }}
    />
  );
}
