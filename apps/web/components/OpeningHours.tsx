'use client';

// A hub's opening hours (Fase 2 punto 5, ADR-032), rendered from the list of
// { day, opens, closes } intervals the hub declared. A day with a lunch
// break carries two intervals, joined with a comma; consecutive days that
// share the exact same schedule collapse into one range row (e.g. "Lun–Ven
// 08:00–12:30, 15:00–19:30") instead of repeating the same line seven times.

import { useTranslations } from 'next-intl';
import { DAY_KEYS, type DayKey, type OpeningHoursEntry } from '@mercurio/shared';

function intervalsLabel(intervals: OpeningHoursEntry[]): string {
  return intervals.map((iv) => `${iv.opens}–${iv.closes}`).join(', ');
}

interface Group {
  firstDay: DayKey;
  lastDay: DayKey;
  intervals: OpeningHoursEntry[];
}

function groupByConsecutiveSchedule(hours: OpeningHoursEntry[]): Group[] {
  const byDay = new Map<DayKey, OpeningHoursEntry[]>();
  for (const entry of hours) {
    byDay.set(
      entry.day,
      [...(byDay.get(entry.day) ?? []), entry].sort((a, b) => a.opens.localeCompare(b.opens)),
    );
  }

  const groups: Group[] = [];
  DAY_KEYS.forEach((day, dayIndex) => {
    const intervals = byDay.get(day);
    if (!intervals || intervals.length === 0) return;
    const prev = groups[groups.length - 1];
    const isConsecutive = prev && DAY_KEYS.indexOf(prev.lastDay) === dayIndex - 1;
    if (prev && isConsecutive && intervalsLabel(prev.intervals) === intervalsLabel(intervals)) {
      prev.lastDay = day;
    } else {
      groups.push({ firstDay: day, lastDay: day, intervals });
    }
  });
  return groups;
}

export function OpeningHours({
  hours,
  compact = false,
}: {
  hours: OpeningHoursEntry[];
  /** Inline "·"-separated line (board card) vs. a stacked list (hub card). */
  compact?: boolean;
}) {
  const t = useTranslations('hub');
  const groups = groupByConsecutiveSchedule(hours);
  if (groups.length === 0) return null;

  const dayLabel = (group: Group): string =>
    group.firstDay === group.lastDay
      ? t(`days.${group.firstDay}`)
      : `${t(`days.${group.firstDay}`)}–${t(`days.${group.lastDay}`)}`;

  if (compact) {
    return (
      <span className="small muted">
        {t('hoursLegend')}:{' '}
        {groups.map((g) => `${dayLabel(g)} ${intervalsLabel(g.intervals)}`).join(' · ')}
      </span>
    );
  }

  return (
    <div className="small">
      <span className="muted">{t('hoursLegend')}</span>
      <ul className="opening-hours">
        {groups.map((g) => (
          <li key={g.firstDay}>
            <span className="muted">{dayLabel(g)}</span>
            <span>{intervalsLabel(g.intervals)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
