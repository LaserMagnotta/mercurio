'use client';

// Reusable QR field (ADR-021): the universal text input PLUS an in-page camera
// scanner where the browser supports it. The text input NEVER goes away — a
// hardware scanner, the phone's camera app, or manual typing all paste into it,
// and that path works on every browser. The scanner is a progressive
// enhancement: it decodes with the native BarcodeDetector (no decoding library
// in the bundle), the camera stream stays on the device, and no frame is ever
// stored or uploaded.
//
// Contract-neutral: on a successful scan we call `onChange` with the decoded
// string exactly as if the operator had pasted it. The parent form keeps owning
// the value and whatever it does with it — parseQrInput for the parcel QR
// (ADR-018 §6), the bare token for the claim QR (ADR-016). This component adds
// a way to FILL the field, never a new form field.
//
// Client-only APIs (navigator.mediaDevices, BarcodeDetector) are touched only
// inside effects and handlers, never at render/import time, so the component
// server-renders safely without next/dynamic (unlike the Leaflet map of
// ADR-018 §4, whose library touches `window` at import).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { qrScanErrorKind } from '../lib/qr-scan-error';

type ScanError = 'insecure' | 'denied' | 'notfound' | 'generic';

const ERROR_COPY: Record<
  ScanError,
  'errorInsecure' | 'errorDenied' | 'errorNotFound' | 'errorGeneric'
> = {
  insecure: 'errorInsecure',
  denied: 'errorDenied',
  notfound: 'errorNotFound',
  generic: 'errorGeneric',
};

// Poll the detector a few times per second: instant to a human, far easier on
// the battery than decoding every animation frame.
const SCAN_INTERVAL_MS = 250;

export interface QrScanInputProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}

export function QrScanInput({ id, label, hint, value, onChange }: QrScanInputProps) {
  const t = useTranslations('qrScan');
  const tCommon = useTranslations('common');

  // Whether in-page scanning is possible at all — resolved on the client after
  // mount (SSR and the first client render both read `false`, so no hydration
  // mismatch), because BarcodeDetector is absent on many browsers and we ship
  // no decoder as a fallback (ADR-021 §2).
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ScanError | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectingRef = useRef(false);
  // Keep the latest onChange without re-subscribing the camera effect.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const Detector = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
      if (!Detector || !navigator.mediaDevices?.getUserMedia) return;
      try {
        const formats = await Detector.getSupportedFormats();
        if (!formats.includes('qr_code')) return;
      } catch {
        // A detector that cannot even list its formats is not usable.
        return;
      }
      if (!cancelled) setSupported(true);
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Release the camera and clear the decode loop. Called on close and on
   *  unmount so no frame — and no camera indicator light — outlives the scan
   *  (privacy, ADR-021 §3). */
  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    detectingRef.current = false;
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchOn(false);
    setTorchAvailable(false);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  // Own the camera lifecycle from an effect keyed on `open`: it runs AFTER the
  // <video> element is committed, so attaching the stream never races the
  // mount, and its cleanup guarantees the camera is released when the scanner
  // closes or the component unmounts.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function run() {
      // getUserMedia needs a secure context; localhost counts, plain http does
      // not. Say so plainly instead of failing opaquely.
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('insecure');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Back camera on phones; `ideal` still yields a camera on laptops
          // that only face the user, rather than failing outright.
          video: { facingMode: { ideal: 'environment' } },
        });
      } catch (err) {
        if (!cancelled) setError(qrScanErrorKind(err));
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      // The effect runs after the <video> is committed, so the ref is set;
      // guard anyway to narrow the type and to bail (rather than hold the
      // camera open uselessly) in the impossible case it is not.
      const video = videoRef.current;
      const Detector = window.BarcodeDetector;
      if (!video || !Detector) {
        setError('generic');
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Some browsers gate play() on a gesture; the click that opened the
        // scanner is one, but the loop below decodes regardless of play state.
      }

      const track = stream.getVideoTracks()[0];
      if (track?.getCapabilities?.().torch) setTorchAvailable(true);

      const detector = new Detector({ formats: ['qr_code'] });
      timerRef.current = setInterval(() => {
        if (detectingRef.current) return; // skip if the previous detect is still running
        detectingRef.current = true;
        void detector
          .detect(video)
          .then((codes) => {
            const hit = codes.find((c) => c.rawValue.trim() !== '');
            if (hit) {
              onChangeRef.current(hit.rawValue);
              close();
            }
          })
          .catch(() => {
            // Transient decode misses between good frames are expected.
          })
          .finally(() => {
            detectingRef.current = false;
          });
      }, SCAN_INTERVAL_MS);
    }

    void run();

    return () => {
      cancelled = true;
      stop();
    };
  }, [open, stop, close]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      // Torch could not be flipped: leave the toggle where it was.
    }
  }, [torchOn]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="hint">{hint}</span>

      {supported && !open && (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          {t('scanCta')}
        </button>
      )}

      {open && (
        <div className="qr-scan" role="group" aria-label={t('scanning')}>
          {error ? (
            <div className="stack-sm">
              <p className="field-error" role="alert">
                {t(ERROR_COPY[error])}
              </p>
              <button type="button" className="btn btn-sm" onClick={close}>
                {tCommon('close')}
              </button>
            </div>
          ) : (
            <>
              <div className="qr-scan-viewport">
                <video ref={videoRef} className="qr-scan-video" muted playsInline />
                <div className="qr-scan-reticle" aria-hidden="true" />
              </div>
              <p className="hint">{t('aim')}</p>
              <p className="hint">{t('privacyNote')}</p>
              <div className="row">
                {torchAvailable && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={torchOn}
                    onClick={() => void toggleTorch()}
                  >
                    {torchOn ? t('torchOff') : t('torchOn')}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={close}>
                  {tCommon('close')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
