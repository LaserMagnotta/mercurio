'use client';

// A hub's opening hours (Fase 2 punto 5), rendered from the day/range → time
// map the hub declared. Handles both shapes the data takes: individual day
// codes (mon…sun, as the registration form emits) and ranges ("mon-sat", as
// the seed uses). Unknown keys render verbatim rather than being dropped —
// showing the hub's real declaration beats hiding it behind a guess.

import { useTranslations } from 'next-intl';

const KNOWN_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type KnownDay = (typeof KNOWN_DAYS)[number];
const isKnownDay = (s: string): s is KnownDay => (KNOWN_DAYS as readonly string[]).includes(s);

export function OpeningHours({
  hours,
  compact = false,
}: {
  hours: Record<string, string>;
  /** Inline "·"-separated line (board card) vs. a stacked list (hub card). */
  compact?: boolean;
}) {
  const t = useTranslations('hub');
  const entries = Object.entries(hours).filter(([, v]) => typeof v === 'string' && v.trim() !== '');
  if (entries.length === 0) return null;

  const dayLabel = (key: string): string => {
    const [from, to, ...rest] = key.split('-');
    if (rest.length === 0 && from && to && isKnownDay(from) && isKnownDay(to)) {
      return `${t(`days.${from}`)}–${t(`days.${to}`)}`;
    }
    return isKnownDay(key) ? t(`days.${key}`) : key;
  };

  if (compact) {
    return (
      <span className="small muted">
        {t('hoursLegend')}: {entries.map(([d, time]) => `${dayLabel(d)} ${time}`).join(' · ')}
      </span>
    );
  }

  return (
    <div className="small">
      <span className="muted">{t('hoursLegend')}</span>
      <ul className="opening-hours">
        {entries.map(([day, time]) => (
          <li key={day}>
            <span className="muted">{dayLabel(day)}</span>
            <span>{time}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
