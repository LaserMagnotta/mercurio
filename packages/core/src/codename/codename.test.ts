import { describe, expect, it } from 'vitest';
import {
  CODENAME_ADJECTIVES,
  CODENAME_ANIMALS,
  CODENAME_COMBINATIONS,
  CODENAME_MAX_SERIAL,
  CODENAME_MIN_SERIAL,
  CODENAME_PATTERN,
  generateCodename,
} from './codename.js';

/** A seeded LCG so the "distribution" assertions are reproducible; the
 *  production default is Math.random (a codename is a label, not a secret). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('generateCodename', () => {
  it('matches the anchored Animal-Adjective-NNN shape', () => {
    const rand = seeded(1);
    for (let i = 0; i < 5000; i++) {
      expect(generateCodename(rand)).toMatch(CODENAME_PATTERN);
    }
  });

  it('keeps the serial in [MIN, MAX] with exactly three digits', () => {
    const rand = seeded(2);
    for (let i = 0; i < 5000; i++) {
      const serial = Number(generateCodename(rand).split('-')[2]);
      expect(serial).toBeGreaterThanOrEqual(CODENAME_MIN_SERIAL);
      expect(serial).toBeLessThanOrEqual(CODENAME_MAX_SERIAL);
    }
  });

  it('never emits a leading-zero serial (100..999, never 007)', () => {
    expect(CODENAME_MIN_SERIAL).toBe(100);
    const rand = seeded(3);
    for (let i = 0; i < 5000; i++) {
      expect(generateCodename(rand).split('-')[2]).not.toMatch(/^0/);
    }
  });

  it('reaches both serial extremes', () => {
    // random()=0 -> MIN; random() just below 1 -> MAX. Assert the arithmetic
    // maps the endpoints as intended rather than trusting a sampling run.
    expect(generateCodename(() => 0).split('-')[2]).toBe(String(CODENAME_MIN_SERIAL));
    expect(generateCodename(() => 0.999999).split('-')[2]).toBe(String(CODENAME_MAX_SERIAL));
  });

  it('agrees the adjective with the animal gender for every emitted pair', () => {
    // The whole reason animal and adjective are not independent words: a
    // masculine animal must take the masculine adjective form and vice versa.
    const bySurface = new Map<string, 'm' | 'f'>();
    for (const a of CODENAME_ANIMALS) {
      bySurface.set(a.word, a.gender);
    }
    const masc = new Set(CODENAME_ADJECTIVES.map((adj) => adj[0]));
    const fem = new Set(CODENAME_ADJECTIVES.map((adj) => adj[1]));

    const rand = seeded(4);
    for (let i = 0; i < 20000; i++) {
      const [animal, adjective] = generateCodename(rand).split('-');
      const gender = bySurface.get(animal!)!;
      if (gender === 'm') {
        expect(masc.has(adjective!)).toBe(true);
      } else {
        expect(fem.has(adjective!)).toBe(true);
      }
    }
  });
});

describe('codename word lists', () => {
  it('has no duplicate animals', () => {
    const words = CODENAME_ANIMALS.map((a) => a.word);
    expect(new Set(words).size).toBe(words.length);
  });

  it('has no duplicate adjective forms and no blank inflection', () => {
    const masc = CODENAME_ADJECTIVES.map((a) => a[0]);
    expect(new Set(masc).size).toBe(masc.length);
    for (const [m, f] of CODENAME_ADJECTIVES) {
      expect(m.length).toBeGreaterThan(0);
      expect(f.length).toBeGreaterThan(0);
    }
  });

  it('is pure ASCII, capitalized, so codenames stay URL/email-safe', () => {
    const surfaces = [
      ...CODENAME_ANIMALS.map((a) => a.word),
      ...CODENAME_ADJECTIVES.flatMap((a) => [a[0], a[1]]),
    ];
    for (const w of surfaces) {
      expect(w).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('reports a combination count matching the lists and serial span', () => {
    expect(CODENAME_COMBINATIONS).toBe(
      CODENAME_ANIMALS.length *
        CODENAME_ADJECTIVES.length *
        (CODENAME_MAX_SERIAL - CODENAME_MIN_SERIAL + 1),
    );
    // Sanity floor: the minting probe in apps/api relies on a roomy space.
    expect(CODENAME_COMBINATIONS).toBeGreaterThan(1_000_000);
  });
});
