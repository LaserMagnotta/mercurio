'use client';

// Photo certification input (ADR-018 §6 + ADR-020): the operator shoots or
// picks up to 10 photos; each is re-encoded ON DEVICE (EXIF stripped — no
// geotag ever leaves the phone) and hashed with WebCrypto. The parent form
// declares the sha256 list to the API as the certification, then uploads the
// exact hashed bytes so the counterparties can SEE what was certified.

import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_PHOTO_HASHES } from '../lib/photo-hash';
import { capturePhoto, type CapturedPhoto } from '../lib/photo-capture';

export interface PhotoHashInputProps {
  id: string;
  photos: CapturedPhoto[];
  onChange: (photos: CapturedPhoto[]) => void;
  /** Overrides the generic "parcel photos" label — the Spedisci form mounts
   *  two instances that certify different kinds (content/sealed, ADR-022). */
  label?: string;
}

export function PhotoHashInput({ id, photos, onChange, label }: PhotoHashInputProps) {
  const t = useTranslations('photos');
  const [hashing, setHashing] = useState(false);
  const [decodeError, setDecodeError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTO_HASHES);
    setDecodeError(false);
    if (files.length === 0) {
      onChange([]);
      return;
    }
    setHashing(true);
    try {
      onChange(await Promise.all(files.map(capturePhoto)));
    } catch {
      // One undecodable file rejects the whole pick: silently skipping it
      // would certify fewer photos than the operator believes they took.
      if (inputRef.current) inputRef.current.value = '';
      onChange([]);
      setDecodeError(true);
    } finally {
      setHashing(false);
    }
  };

  const clear = () => {
    if (inputRef.current) inputRef.current.value = '';
    setDecodeError(false);
    onChange([]);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label ?? t('label')}</label>
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => void pick(e)}
      />
      <span className="hint">{t('hint', { max: MAX_PHOTO_HASHES })}</span>
      {hashing && <span className="hint">{t('hashing')}</span>}
      {decodeError && (
        <span className="field-error" role="alert">
          {t('decodeError')}
        </span>
      )}
      {photos.length > 0 && (
        <span className="row small">
          <span className="badge badge-success">{t('ready', { count: photos.length })}</span>
          <button type="button" className="link-button" onClick={clear}>
            {t('clear')}
          </button>
        </span>
      )}
    </div>
  );
}
