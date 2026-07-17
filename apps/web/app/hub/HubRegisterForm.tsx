'use client';

// Hub registration (POST /me/roles/hub): the shop declares its public
// constraints once — address, opening hours, size/weight caps, undeclared
// policy, fee percentage and storage cap (CLAUDE.md "Hub — dettagli").
// The form validates locally with the same bounds as the API route; the
// API remains the judge.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_STORAGE_DAYS } from '@mercurio/shared';
import { registerHubRole } from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Mirrors the API route's zod bounds (apps/api/routes/me.ts `hubBody`). */
const FEE_MAX = 30;
const STORAGE_MAX_DAYS = MAX_STORAGE_DAYS;

const isPosInt = (v: string) => /^\d{1,7}$/.test(v) && Number(v) > 0;

export function HubRegisterForm({ onRegistered }: { onRegistered: () => Promise<void> }) {
  const t = useTranslations('hub');
  const errorMessage = useApiErrorMessage();

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [hours, setHours] = useState<Record<string, string>>({});
  const [dimL, setDimL] = useState('');
  const [dimW, setDimW] = useState('');
  const [dimH, setDimH] = useState('');
  const [weightG, setWeightG] = useState('');
  const [acceptsUndeclared, setAcceptsUndeclared] = useState(false);
  const [feePercent, setFeePercent] = useState('10');
  const [maxStorageDays, setMaxStorageDays] = useState('2');
  const [autoAccept, setAutoAccept] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const latNum = Number(lat);
    const lngNum = Number(lng);
    const feeNum = Number(feePercent.replace(',', '.'));
    const storageNum = Number(maxStorageDays);
    const openingHours = Object.fromEntries(
      DAY_KEYS.map((day) => [day, (hours[day] ?? '').trim()]).filter(([, v]) => v !== ''),
    );

    if (name.trim() === '' || address.trim() === '') return setError(t('validation.required'));
    if (!Number.isFinite(latNum) || Math.abs(latNum) > 90) return setError(t('validation.coords'));
    if (!Number.isFinite(lngNum) || Math.abs(lngNum) > 180) return setError(t('validation.coords'));
    if (Object.keys(openingHours).length === 0) return setError(t('validation.hours'));
    if (![dimL, dimW, dimH, weightG].every(isPosInt)) return setError(t('validation.dims'));
    if (!Number.isFinite(feeNum) || feeNum < 0 || feeNum > FEE_MAX) {
      return setError(t('validation.fee', { max: FEE_MAX }));
    }
    if (!Number.isInteger(storageNum) || storageNum < 1 || storageNum > STORAGE_MAX_DAYS) {
      return setError(t('validation.storage', { max: STORAGE_MAX_DAYS }));
    }

    setBusy(true);
    try {
      await registerHubRole({
        name: name.trim(),
        address: address.trim(),
        lat: latNum,
        lng: lngNum,
        openingHours,
        maxDimCmL: Number(dimL),
        maxDimCmW: Number(dimW),
        maxDimCmH: Number(dimH),
        maxWeightG: Number(weightG),
        acceptsUndeclared,
        feePercent: feeNum,
        maxStorageDays: storageNum,
        autoAccept,
      });
      await onRegistered();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('registerTitle')}</h1>
      <p className="muted">{t('registerIntro')}</p>

      <form className="card" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="hub-name">{t('nameLabel')}</label>
          <input id="hub-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="hub-address">{t('addressLabel')}</label>
          <input
            id="hub-address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <div className="dims-grid">
          <div className="field">
            <label htmlFor="hub-lat">{t('latLabel')}</label>
            <input
              id="hub-lat"
              type="text"
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="hub-lng">{t('lngLabel')}</label>
            <input
              id="hub-lng"
              type="text"
              inputMode="decimal"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
            />
          </div>
        </div>
        <p className="hint">{t('coordsHint')}</p>

        <fieldset>
          <legend>{t('hoursLegend')}</legend>
          {DAY_KEYS.map((day) => (
            <div className="field" key={day}>
              <label htmlFor={`hub-h-${day}`}>{t(`days.${day}`)}</label>
              <input
                id={`hub-h-${day}`}
                type="text"
                placeholder={t('hoursPlaceholder')}
                value={hours[day] ?? ''}
                onChange={(e) => setHours({ ...hours, [day]: e.target.value })}
              />
            </div>
          ))}
          <p className="hint">{t('hoursHint')}</p>
        </fieldset>

        <fieldset>
          <legend>{t('limitsLegend')}</legend>
          <div className="dims-grid">
            <div className="field">
              <label htmlFor="hub-l">{t('maxLengthLabel')}</label>
              <input
                id="hub-l"
                type="number"
                min="1"
                inputMode="numeric"
                value={dimL}
                onChange={(e) => setDimL(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="hub-w">{t('maxWidthLabel')}</label>
              <input
                id="hub-w"
                type="number"
                min="1"
                inputMode="numeric"
                value={dimW}
                onChange={(e) => setDimW(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="hub-h">{t('maxHeightLabel')}</label>
              <input
                id="hub-h"
                type="number"
                min="1"
                inputMode="numeric"
                value={dimH}
                onChange={(e) => setDimH(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="hub-weight">{t('maxWeightLabel')}</label>
            <input
              id="hub-weight"
              type="number"
              min="1"
              inputMode="numeric"
              value={weightG}
              onChange={(e) => setWeightG(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="hub-storage">{t('storageLabel')}</label>
            <input
              id="hub-storage"
              type="number"
              min="1"
              max={STORAGE_MAX_DAYS}
              inputMode="numeric"
              value={maxStorageDays}
              onChange={(e) => setMaxStorageDays(e.target.value)}
            />
            <span className="hint">{t('storageHint', { max: STORAGE_MAX_DAYS })}</span>
          </div>
          <div className="checkbox-row">
            <input
              id="hub-undeclared"
              type="checkbox"
              checked={acceptsUndeclared}
              onChange={(e) => setAcceptsUndeclared(e.target.checked)}
            />
            <label htmlFor="hub-undeclared">{t('undeclaredLabel')}</label>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="hub-fee">{t('feeLabel')}</label>
          <input
            id="hub-fee"
            type="text"
            inputMode="decimal"
            value={feePercent}
            onChange={(e) => setFeePercent(e.target.value)}
          />
          <span className="hint">{t('feeHint', { max: FEE_MAX })}</span>
        </div>

        <div className="checkbox-row">
          <input
            id="hub-auto"
            type="checkbox"
            checked={autoAccept}
            onChange={(e) => setAutoAccept(e.target.checked)}
          />
          <label htmlFor="hub-auto">
            {t('autoAcceptLabel')} <span className="hint">{t('autoAcceptHint')}</span>
          </label>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('registering') : t('registerSubmit')}
        </button>
      </form>
    </div>
  );
}
