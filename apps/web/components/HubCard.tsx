'use client';

// One hub as the sender sees it when picking a counterparty: physical
// limits, fee, storage ceiling and the owner's hub-role rating (ADR-017:
// ratings visible wherever a counterparty is chosen).

import { useLocale, useTranslations } from 'next-intl';
import { type Hub, venuePhotoUrl } from '../lib/api/endpoints';
import { formatPercent } from '../lib/format';
import { OpeningHours } from './OpeningHours';
import { RatingStars } from './RatingStars';

export function HubCard({ hub }: { hub: Hub }) {
  const t = useTranslations('hubs');
  const locale = useLocale();
  return (
    <article className="card stack-sm">
      <div className="row-between">
        <h3>{hub.name}</h3>
        <RatingStars rating={hub.rating} />
      </div>
      {hub.venuePhotos.length > 0 && (
        <ul className="venue-gallery venue-gallery-readonly">
          {hub.venuePhotos.map((sha256) => (
            <li key={sha256}>
              <img src={venuePhotoUrl(hub.id, sha256)} alt={t('venuePhotoAlt')} loading="lazy" />
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{hub.address}</p>
      <p className="small">
        {t('fee', { percent: formatPercent(hub.feePercent, locale) })} ·{' '}
        {t('maxDims', {
          l: hub.maxDims.lengthCm,
          w: hub.maxDims.widthCm,
          h: hub.maxDims.heightCm,
        })}{' '}
        {t('maxWeight', { kg: hub.maxWeightG / 1000 })} ·{' '}
        {t('maxStorage', { days: hub.maxStorageDays })}
      </p>
      <OpeningHours hours={hub.openingHours} />
      <p className="row small">
        <span className={`badge ${hub.acceptsUndeclared ? 'badge-success' : 'badge-neutral'}`}>
          {hub.acceptsUndeclared ? t('acceptsUndeclared') : t('noUndeclared')}
        </span>
        {!hub.walletConnected && <span className="badge badge-warning">{t('walletOff')}</span>}
      </p>
    </article>
  );
}
