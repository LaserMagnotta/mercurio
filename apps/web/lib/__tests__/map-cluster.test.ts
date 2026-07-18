// Grid clustering for the hub discovery map (ADR-030): pure math, so pin it.

import { describe, expect, it } from 'vitest';
import { cellSizeDeg, clusterPoints } from '../map-cluster';

const p = (id: string, lat: number, lng: number) => ({ id, lat, lng });

describe('map-cluster', () => {
  it('cells shrink as zoom grows and stay clamped at the extremes', () => {
    expect(cellSizeDeg(6)).toBeGreaterThan(cellSizeDeg(10));
    expect(cellSizeDeg(-5)).toBe(cellSizeDeg(0));
    expect(cellSizeDeg(30)).toBe(cellSizeDeg(19));
  });

  it('groups nearby points at low zoom and splits them when zooming in', () => {
    const points = [p('a', 45.0, 9.0), p('b', 45.01, 9.01), p('c', 41.9, 12.5)];
    const far = clusterPoints(points, 5);
    expect(far).toHaveLength(2);
    const milano = far.find((c) => c.points.length === 2)!;
    expect(milano.points.map((x) => x.id).sort()).toEqual(['a', 'b']);
    // The cluster sits at the members' mean position.
    expect(milano.lat).toBeCloseTo(45.005, 6);
    expect(milano.lng).toBeCloseTo(9.005, 6);

    // Zoomed in, every point stands alone.
    const near = clusterPoints(points, 15);
    expect(near).toHaveLength(3);
    expect(near.every((c) => c.points.length === 1)).toBe(true);
  });

  it('never loses or duplicates a point', () => {
    const points = Array.from({ length: 200 }, (_, i) =>
      p(`h${i}`, 36 + (i % 20) * 0.55, 6 + Math.floor(i / 20) * 1.3),
    );
    for (const zoom of [4, 8, 12, 16]) {
      const clusters = clusterPoints(points, zoom);
      const ids = clusters.flatMap((c) => c.points.map((x) => x.id)).sort();
      expect(ids).toEqual(points.map((x) => x.id).sort());
    }
  });
});
