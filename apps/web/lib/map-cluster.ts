// Grid-based marker clustering for the hub discovery map (ADR-030). Pure and
// dependency-free on purpose: at the 10k-hub target the page never RECEIVES
// more than one bounded page of hubs, so a screen-space grid is enough — no
// leaflet.markercluster, no quadtree. Cells shrink with zoom; markers in the
// same cell collapse into one cluster whose position is the members' mean.

export interface ClusterPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface Cluster<P extends ClusterPoint> {
  lat: number;
  lng: number;
  points: P[];
}

/** Cell size in degrees for a given Leaflet zoom: ~1/8 of a 256px tile, so
 *  clusters split apart naturally while zooming in. Clamped so world-level
 *  zooms cannot produce a single planet-wide cell. */
export function cellSizeDeg(zoom: number): number {
  return 360 / (2 ** Math.min(Math.max(zoom, 0), 19) * 8);
}

export function clusterPoints<P extends ClusterPoint>(points: readonly P[], zoom: number): Cluster<P>[] {
  const cell = cellSizeDeg(zoom);
  const byCell = new Map<string, P[]>();
  for (const p of points) {
    const key = `${Math.floor(p.lat / cell)}:${Math.floor(p.lng / cell)}`;
    const list = byCell.get(key) ?? [];
    list.push(p);
    byCell.set(key, list);
  }
  return [...byCell.values()].map((members) => ({
    lat: members.reduce((acc, p) => acc + p.lat, 0) / members.length,
    lng: members.reduce((acc, p) => acc + p.lng, 0) / members.length,
    points: members,
  }));
}
