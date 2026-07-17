'use client';

// Thumbnails of the CERTIFIED photos of one custody event (ADR-020 §4).
// Only hashes with an uploaded blob render — a hash without bytes is a valid
// certification that simply cannot be shown (pre-blob history, third-party
// clients, failed uploads). Each thumb opens the full photo in a new tab;
// the URL is the session-authorized API proxy, never a public link.

import { useTranslations } from 'next-intl';
import { shipmentPhotoUrl } from '../lib/api/endpoints';

export function PhotoStrip({
  shipmentId,
  hashes,
  available,
}: {
  shipmentId: string;
  /** The event's declared photoSha256 list (custody payload). */
  hashes: string[];
  /** sha256 of the photos that actually have an uploaded blob. */
  available: ReadonlySet<string>;
}) {
  const t = useTranslations('photos');
  const shown = hashes.filter((hash) => available.has(hash));
  if (shown.length === 0) return null;
  return (
    <span className="photo-strip">
      {shown.map((hash) => {
        const url = shipmentPhotoUrl(shipmentId, hash);
        return (
          <a key={hash} href={url} target="_blank" rel="noreferrer" title={t('open')}>
            <img className="photo-thumb" src={url} alt={t('thumbAlt')} loading="lazy" />
          </a>
        );
      })}
    </span>
  );
}
