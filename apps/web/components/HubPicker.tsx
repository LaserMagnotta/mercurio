'use client';

// Hub combobox on the paginated search contract (ADR-030, Fase 5): the
// internal pickers (send, reroute, trip declaration) stop downloading the
// whole hub table and search server-side instead — `q` on name/address,
// `near` for distance-sorted results, one bounded page. The ARIA combobox
// pattern is hand-rolled: input + listbox, arrow keys, Enter/Escape.
//
// Selection semantics: typing only searches; the value changes exclusively
// when an option is picked, so an abandoned search never clears a valid
// choice. Callers that need an "empty again" state (reroute's "keep the
// current destination") render their own reset control.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { searchHubs, type Hub } from '../lib/api/endpoints';
import { formatKm } from '../lib/format';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;

export interface HubPickerProps {
  id: string;
  label: string;
  value: Hub | null;
  onChange: (hub: Hub) => void;
  /** Sort results by distance from here (e.g. the already-picked origin). */
  near?: { lat: number; lng: number } | null | undefined;
  /** Hub ids to hide (origin ≠ destination rules). */
  excludeIds?: ReadonlyArray<string | undefined>;
  invalid?: boolean;
}

export function HubPicker({ id, label, value, onChange, near, excludeIds, invalid }: HubPickerProps) {
  const t = useTranslations('hubPicker');
  const locale = useLocale();

  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Hub[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const seqRef = useRef(0);

  const excludeKey = useMemo(
    () => (excludeIds ?? []).filter(Boolean).sort().join(','),
    [excludeIds],
  );
  const nearLat = near?.lat;
  const nearLng = near?.lng;

  useEffect(() => {
    if (!editing) return;
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const trimmed = query.trim();
      searchHubs({
        ...(trimmed !== '' && { q: trimmed }),
        ...(nearLat !== undefined && nearLng !== undefined && { near: `${nearLat},${nearLng}` }),
        limit: PAGE_SIZE,
      })
        .then((res) => {
          if (seqRef.current !== seq) return;
          const excluded = new Set(excludeKey.split(',').filter(Boolean));
          setItems(res.hubs.filter((h) => !excluded.has(h.id)));
          setTotal(res.total);
          setFailed(false);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setItems([]);
          setFailed(true);
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editing, query, nearLat, nearLng, excludeKey]);

  const pick = (hub: Hub) => {
    onChange(hub);
    setEditing(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        pick(items[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setEditing(false);
      setQuery('');
    }
  };

  const listboxId = `${id}-listbox`;
  const displayText = editing ? query : value ? `${value.name} — ${value.address}` : '';

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="combobox">
        <input
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('placeholder')}
          value={displayText}
          aria-expanded={editing}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            setEditing(true);
            setQuery('');
          }}
          onBlur={() => {
            // Option clicks land on mousedown, before this blur fires.
            setEditing(false);
            setQuery('');
          }}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {editing && (
          <ul className="combobox-list" id={listboxId} role="listbox" aria-label={label}>
            {loading && <li className="combobox-status">{t('searching')}</li>}
            {!loading && failed && <li className="combobox-status">{t('loadError')}</li>}
            {!loading && !failed && items.length === 0 && (
              <li className="combobox-status">{t('noResults')}</li>
            )}
            {items.map((hub, i) => (
              <li
                key={hub.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className="combobox-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(hub);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="combobox-option-name">{hub.name}</span>
                <span className="combobox-option-meta">
                  <span>{hub.address}</span>
                  {hub.distanceKm !== undefined && <span>{formatKm(hub.distanceKm, locale)}</span>}
                </span>
              </li>
            ))}
            {/* Only when a further page truly exists — exclusions alone must
                not suggest missing results. */}
            {!loading && !failed && total > PAGE_SIZE && (
              <li className="combobox-status">
                {t('showingOf', { shown: items.length, total })}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
