'use client';

// The in-app route map (ADR-015): Leaflet + OpenStreetMap tiles — no API
// key, no paid service, correct OSM attribution. The polyline joins the
// stops IN THE ORDER computed by GET /trips/:id/route (straight lines: an
// itinerary visualization, not road routing — the real routing happens in
// Google Maps, only after the carrier explicitly taps the export button).
//
// Loaded with next/dynamic ssr:false — Leaflet touches `window` at import.

import { MapContainer, Marker, Polyline, Popup, TileLayer } from 'react-leaflet';
import { divIcon, latLngBounds, type LatLngTuple } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface TripMapStop {
  hubId: string;
  hubName: string;
  lat: number;
  lng: number;
  kind: 'pickup' | 'drop';
  preview: boolean;
}

export interface TripMapProps {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  stops: TripMapStop[];
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

export default function TripMap({ origin, destination, stops, labels }: TripMapProps) {
  const path: LatLngTuple[] = [
    [origin.lat, origin.lng],
    ...stops.map((s): LatLngTuple => [s.lat, s.lng]),
    [destination.lat, destination.lng],
  ];
  const bounds = latLngBounds(path).pad(0.25);

  return (
    <MapContainer bounds={bounds} className="trip-map" scrollWheelZoom={false}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution={OSM_ATTRIBUTION}
      />
      <Polyline positions={path} pathOptions={{ color: '#f7931a', weight: 4, opacity: 0.85 }} />

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
