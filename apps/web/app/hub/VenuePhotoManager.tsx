'use client';

// Venue photos of the owner's hub (Fase 2 punto 6, ADR-028): a small public
// storefront gallery. Same on-device pipeline as shipment photos — decode →
// canvas → JPEG (EXIF stripped) → sha256 (ADR-020 §2) — but tied to the hub and
// publicly readable. The owner uploads and removes; a sender sees them on the
// hub card.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_VENUE_PHOTOS } from '@mercurio/shared';
import {
  deleteVenuePhoto,
  getVenuePhotos,
  uploadVenuePhoto,
  venuePhotoUrl,
  type VenuePhoto,
} from '../../lib/api/endpoints';
import { capturePhoto } from '../../lib/photo-capture';
import { useApiErrorMessage } from '../../lib/api-error-message';

export function VenuePhotoManager({ hubId }: { hubId: string }) {
  const t = useTranslations('hub');
  const errorMessage = useApiErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [photos, setPhotos] = useState<VenuePhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPhotos((await getVenuePhotos(hubId)).photos);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [hubId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPick = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await capturePhoto(file);
      await uploadVenuePhoto(prepared);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (sha256: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteVenuePhoto(sha256);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const full = photos.length >= MAX_VENUE_PHOTOS;

  return (
    <section className="card stack-sm">
      <h2>{t('venueTitle')}</h2>
      <p className="muted small">{t('venueIntro', { max: MAX_VENUE_PHOTOS })}</p>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {photos.length > 0 && (
        <ul className="venue-gallery">
          {photos.map((p) => (
            <li key={p.sha256}>
              <img src={venuePhotoUrl(hubId, p.sha256)} alt={t('venuePhotoAlt')} loading="lazy" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void remove(p.sha256)}
              >
                {t('venueRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onPick(file);
        }}
      />
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || full}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? t('venueUploading') : full ? t('venueFull') : t('venueAdd')}
      </button>
    </section>
  );
}
