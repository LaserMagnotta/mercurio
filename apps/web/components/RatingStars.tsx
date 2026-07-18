'use client';

// Per-role rating aggregate (ADR-017): shown wherever a counterparty is
// chosen. Zero reviews reads "new", never a misleading 0-star average.

import { useLocale, useTranslations } from 'next-intl';
import { Icon } from './Icon';

export interface RatingValue {
  averageStars: number | null;
  reviewCount: number;
}

export function RatingStars({ rating }: { rating: RatingValue }) {
  const locale = useLocale();
  const t = useTranslations('common');
  if (rating.averageStars === null || rating.reviewCount === 0) {
    return <span className="badge badge-neutral">{t('ratingNone')}</span>;
  }
  const stars = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    rating.averageStars,
  );
  return (
    <span className="rating" aria-label={t('ratingAria', { stars, count: rating.reviewCount })}>
      <span aria-hidden="true">
        <span className="rating-star">
          <Icon name="star" filled size={14} />
        </span>{' '}
        {stars}{' '}
        {t('ratingCount', { count: rating.reviewCount })}
      </span>
    </span>
  );
}
