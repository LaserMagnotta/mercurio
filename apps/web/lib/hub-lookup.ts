// Targeted hub lookups by id (ADR-030, Fase 5): detail pages need a handful
// of hub names/coordinates — origin, destination, current, leg endpoints —
// never the whole table. Each id is fetched once per page load via
// GET /hubs/:id and memoized module-wide; a failed fetch falls back to the
// truncated id, exactly like the old full-list miss did.

import { useEffect, useMemo, useState } from 'react';
import { getHub, type Hub } from './api/endpoints';

const cache = new Map<string, Promise<Hub | null>>();

function fetchHubCached(id: string): Promise<Hub | null> {
  let promise = cache.get(id);
  if (!promise) {
    promise = getHub(id).catch(() => {
      // Do not memoize failures: a transient error stays retryable.
      cache.delete(id);
      return null;
    });
    cache.set(id, promise);
  }
  return promise;
}

/** Resolve a set of hub ids to Hub objects as they load. Ids may repeat or
 *  be null/undefined; the map only ever grows within a component's life. */
export function useHubs(ids: ReadonlyArray<string | null | undefined>): ReadonlyMap<string, Hub> {
  const [hubs, setHubs] = useState<ReadonlyMap<string, Hub>>(() => new Map());
  // Callers pass a fresh array every render: depend on the id SET, not the
  // array identity.
  const key = useMemo(() => {
    const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    return unique.sort().join(',');
  }, [ids]);

  useEffect(() => {
    if (key === '') return;
    let cancelled = false;
    void Promise.all(key.split(',').map(fetchHubCached)).then((resolved) => {
      if (cancelled) return;
      setHubs((prev) => {
        const next = new Map(prev);
        for (const hub of resolved) if (hub) next.set(hub.id, hub);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return hubs;
}

/** Display name with the pre-existing fallback for unknown/unloaded ids. */
export function hubNameFrom(hubs: ReadonlyMap<string, Hub>, hubId: string | null): string {
  if (!hubId) return '—';
  return hubs.get(hubId)?.name ?? `${hubId.slice(0, 8)}…`;
}
