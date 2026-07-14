'use client';

// Photo certification input: the operator shoots/picks up to 10 photos, the
// component hashes them with WebCrypto and hands the sha256 list to the
// parent form. The photos NEVER leave the device (ARCHITECTURE.md §5
// precisazione 12): only the declared hashes reach the API, entering the
// custody chain as the certification.

import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_PHOTO_HASHES, sha256HexOfFile } from '../lib/photo-hash';

export interface PhotoHashInputProps {
  id: string;
  hashes: string[];
  onChange: (hashes: string[]) => void;
}

export function PhotoHashInput({ id, hashes, onChange }: PhotoHashInputProps) {
  const t = useTranslations('photos');
  const [hashing, setHashing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTO_HASHES);
    if (files.length === 0) {
      onChange([]);
      return;
    }
    setHashing(true);
    try {
      onChange(await Promise.all(files.map(sha256HexOfFile)));
    } finally {
      setHashing(false);
    }
  };

  const clear = () => {
    if (inputRef.current) inputRef.current.value = '';
    onChange([]);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{t('label')}</label>
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
      {hashes.length > 0 && (
        <span className="row small">
          <span className="badge badge-success">{t('ready', { count: hashes.length })}</span>
          <button type="button" className="link-button" onClick={clear}>
            {t('clear')}
          </button>
        </span>
      )}
    </div>
  );
}
