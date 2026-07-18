'use client';

// The in-app route map (ADR-015 + ADR-031): Leaflet + OpenStreetMap tiles —
// no API key, no paid service, correct OSM attribution. Since ADR-031 the
// endpoint ships road polylines: the DIRECT O→Dc route is drawn in a muted
// tone and the actual stop-by-stop path in full tone — the visual difference
// between the two IS the deviation the carrier accepted. Any hop the router
// could not shape degrades to a dashed straight chord (display only, never
// money). The km figures shown anywhere stay the pricing metric's (decisione
// C, ADR-031): the polyline communicates shape, not a second number.
//
// Loaded with next/dynamic ssr:false — Leaflet touches `window` at import.

import { MapContainer, Marker, Polyline, Popup, TileLayer } from 'react-leaflet';
import { divIcon, latLngBounds, type LatLngTuple } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ACCENT = '#f7931a';

export interface TripMapStop {
  hubId: string;
  hubName: string;
  lat: number;
  lng: number;
  kind: 'pickup' | 'drop';
  preview: boolean;
}

export interface TripMapGeometrySegment {
  source: 'road' | 'straight';
  points: [number, number][];
}

export interface TripMapRouteGeometry {
  direct: TripMapGeometrySegment;
  segments: TripMapGeometrySegment[];
}

export interface TripMapProps {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  stops: TripMapStop[];
  routeGeometry?: TripMapRouteGeometry;
  labels: {
    origin: string;
    destination: string;
    pickup: string;
    drop: string;
    preview: string;
  };
}

function marker(html: string, kindClass: string, preview = false) {
  return divIcon({
    // Our own class names only — no user-controlled markup.
    html: `<span class="map-marker ${kindClass}${preview ? ' map-marker-preview' : ''}">${html}</span>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export default function TripMap({
  origin,
  destination,
  stops,
  routeGeometry,
  labels,
}: TripMapProps) {
  const markerPath: LatLngTuple[] = [
    [origin.lat, origin.lng],
    ...stops.map((s): LatLngTuple => [s.lat, s.lng]),
    [destination.lat, destination.lng],
  ];
  // Fit the road shapes too: a real road can bow far outside the marker hull.
  const boundsPoints: LatLngTuple[] = [
    ...markerPath,
    ...(routeGeometry?.segments.flatMap((seg) => seg.points) ?? []),
  ];
  const bounds = latLngBounds(boundsPoints).pad(0.25);

  return (
    <MapContainer bounds={bounds} className="trip-map" scrollWheelZoom={false}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution={OSM_ATTRIBUTION}
      />

      {routeGeometry ? (
        <>
          {/* The trip as it would be with no parcels: muted tone underneath. */}
          <Polyline
            positions={routeGeometry.direct.points}
            pathOptions={{
              color: ACCENT,
              weight: 3,
              opacity: 0.35,
              ...(routeGeometry.direct.source === 'straight' && { dashArray: '6 10' }),
            }}
          />
          {/* The actual visit-order path, hop by hop; dashed = straight
              fallback (no road shape available right now). */}
          {routeGeometry.segments.map((seg, i) => (
            <Polyline
              key={i}
              positions={seg.points}
              pathOptions={{
                color: ACCENT,
                weight: 4,
                opacity: 0.9,
                ...(seg.source === 'straight' && { dashArray: '6 10' }),
              }}
            />
          ))}
        </>
      ) : (
        // No geometry from the endpoint: the pre-ADR-031 single chord path.
        <Polyline
          positions={markerPath}
          pathOptions={{ color: ACCENT, weight: 4, opacity: 0.85 }}
        />
      )}

      <Marker position={[origin.lat, origin.lng]} icon={marker('●', 'map-marker-endpoint')}>
        <Popup>{labels.origin}</Popup>
      </Marker>

      {stops.map((stop, i) => (
        <Marker
          key={`${stop.hubId}-${stop.kind}-${i}`}
          position={[stop.lat, stop.lng]}
          icon={marker(
            String(i + 1),
            stop.kind === 'pickup' ? 'map-marker-pickup' : 'map-marker-drop',
            stop.preview,
          )}
        >
          <Popup>
            {i + 1}. {stop.kind === 'pickup' ? labels.pickup : labels.drop} — {stop.hubName}
            {stop.preview ? ` (${labels.preview})` : ''}
          </Popup>
        </Marker>
      ))}

      <Marker
        position={[destination.lat, destination.lng]}
        icon={marker('■', 'map-marker-endpoint')}
      >
        <Popup>{labels.destination}</Popup>
      </Marker>
    </MapContainer>
  );
}
