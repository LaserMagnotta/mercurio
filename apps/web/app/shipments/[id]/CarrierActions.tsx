'use client';

// Carrier side of the double-confirmation checkout (ARCHITECTURE.md §7) and
// the documentary reject at the pickup stage (ADR-012). Rendered on the
// shipment detail page when the signed-in user is the carrier of the BOOKED
// leg: the parcel is on the hub's counter, the carrier scans the QR and
// either confirms (custody passes when both parties confirm within the
// window) or files a reject (custody stays with the hub).

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  confirmCheckout,
  rejectHandoff,
  uploadShipmentPhotos,
  type ShipmentDetail,
} from '../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../lib/api-error-message';
import { parseQrInput } from '../../../lib/qr-input';
import { PhotoHashInput } from '../../../components/PhotoHashInput';
import type { CapturedPhoto } from '../../../lib/photo-capture';

export function CarrierActions({
  detail,
  userId,
  onDone,
}: {
  detail: ShipmentDetail;
  userId: string;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations('carrierOps');
  const tCommon = useTranslations('common');
  const tPhotos = useTranslations('photos');
  const errorMessage = useApiErrorMessage();

  const [qrRaw, setQrRaw] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectPhotos, setRejectPhotos] = useState<CapturedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bookedLeg = detail.legs.find((l) => l.status === 'booked' && l.carrierId === userId);
  if (detail.status !== 'LEG_BOOKED' || !bookedLeg) return null;

  const qrToken = parseQrInput(qrRaw);

  const run = async (fn: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setNotice(await fn());
      setQrRaw('');
      setShowReject(false);
      setRejectReason('');
      setRejectPhotos([]);
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCheckout = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await confirmCheckout(detail.id, qrToken);
      return res.complete ? t('checkoutComplete') : t('checkoutWaitingHub');
    });
  };

  const submitReject = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await rejectHandoff(detail.id, {
        stage: 'pickup_checkout',
        reason: rejectReason.trim(),
        photoSha256: rejectPhotos.map((p) => p.sha256),
      });
      // Certification first, bytes second (ADR-020 §3): a failed upload
      // never voids the filed rejection.
      const failed = await uploadShipmentPhotos(detail.id, rejectPhotos);
      return t('rejectDone') + (failed > 0 ? ` ${tPhotos('uploadFailed', { failed })}` : '');
    });
  };

  return (
    <section className="card stack-sm no-print">
      <h2>{t('title')}</h2>
      <p className="muted small">{t('checkoutIntro')}</p>

      {notice && (
        <p className="alert alert-success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={submitCheckout} className="stack-sm">
        <div className="field">
          <label htmlFor="carrier-qr">{t('qrLabel')}</label>
          <input
            id="carrier-qr"
            type="text"
            autoComplete="off"
            value={qrRaw}
            onChange={(e) => setQrRaw(e.target.value)}
          />
          <span className="hint">{t('qrHint')}</span>
        </div>
        <button className="btn btn-primary" disabled={busy || qrToken === ''}>
          {t('checkoutCta')}
        </button>
      </form>

      <div className="row-between">
        <h3>{t('rejectTitle')}</h3>
        <button type="button" className="btn btn-sm" onClick={() => setShowReject(!showReject)}>
          {showReject ? tCommon('close') : t('rejectOpen')}
        </button>
      </div>
      <p className="muted small">{t('rejectIntro')}</p>
      {showReject && (
        <form onSubmit={submitReject} className="stack-sm">
          <div className="field">
            <label htmlFor="carrier-reject-reason">{t('rejectReasonLabel')}</label>
            <textarea
              id="carrier-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              maxLength={500}
            />
          </div>
          <PhotoHashInput
            id="carrier-reject-photos"
            photos={rejectPhotos}
            onChange={setRejectPhotos}
          />
          <button
            className="btn btn-danger"
            disabled={busy || rejectReason.trim().length < 3 || rejectPhotos.length === 0}
          >
            {t('rejectCta')}
          </button>
        </form>
      )}
    </section>
  );
}
