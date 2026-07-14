// Device-local memory of what this browser created. The API has no
// GET /me/shipments or GET /me/trips yet (part 2 of the web work), so the
// UI keeps the ids it saw at creation time in localStorage — ids only,
// no amounts and no PII.

export interface RecentShipment {
  id: string;
  createdAt: string;
}

export interface ActiveTrip {
  id: string;
  expiresAt: string;
}

const SHIPMENTS_KEY = 'mercurio.recentShipments';
const TRIP_KEY = 'mercurio.activeTrip';
const MAX_RECENT = 10;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function recentShipments(): RecentShipment[] {
  if (typeof window === 'undefined') return [];
  return safeParse<RecentShipment[]>(window.localStorage.getItem(SHIPMENTS_KEY)) ?? [];
}

export function rememberShipment(id: string): void {
  if (typeof window === 'undefined') return;
  const list = [{ id, createdAt: new Date().toISOString() }].concat(
    recentShipments().filter((s) => s.id !== id),
  );
  window.localStorage.setItem(SHIPMENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

export function activeTrip(): ActiveTrip | null {
  if (typeof window === 'undefined') return null;
  const trip = safeParse<ActiveTrip>(window.localStorage.getItem(TRIP_KEY));
  if (!trip) return null;
  if (new Date(trip.expiresAt).getTime() <= Date.now()) return null;
  return trip;
}

export function rememberTrip(trip: ActiveTrip): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TRIP_KEY, JSON.stringify(trip));
}
