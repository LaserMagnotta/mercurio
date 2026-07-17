'use client';

// Hub-side handoff operations for one shipment (ARCHITECTURE.md §5 and §7):
// origin accept/check-in, double-confirmation checkout, arrival/return
// check-in, OTP pickup, claimed pickup and the documentary handoff-reject.
// Every action is QR + authenticated session; photos are client-hashed
// certifications. The page only OFFERS the actions the state admits — the
// API (and the pure machine behind it) remains the judge of every guard.

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  claimedPickup,
  confirmCheckout,
  getHubs,
  getMyHubRequests,
  getShipment,
  getShipmentPhotos,
  legCheckin,
  legReturn,
  originAccept,
  originCheckin,
  recipientPickup,
  rejectHandoff,
  shipmentPhotoUrl,
  uploadShipmentPhotos,
  type Hub,
  type ShipmentDetail,
  type ShipmentPhoto,
} from '../../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../../lib/api-error-message';
import { useSession } from '../../../../lib/session';
import { parseQrInput } from '../../../../lib/qr-input';
import { formatDateTime } from '../../../../lib/format';
import { statusDescriptionKey } from '../../../../lib/shipment-status';
import { Amount } from '../../../../components/Amount';
import { Codename } from '../../../../components/Codename';
import { PhotoHashInput } from '../../../../components/PhotoHashInput';
import { QrScanInput } from '../../../../components/QrScanInput';
import { StatusBadge } from '../../../../components/StatusBadge';
import type { CapturedPhoto } from '../../../../lib/photo-capture';

type RejectStage = 'hub_checkin' | 'recipient_pickup';

export function HubOpsClient({ id }: { id: string }) {
  const t = useTranslations('hubOps');
  const tCommon = useTranslations('common');
  const tStatuses = useTranslations('statuses');
  const tPhotos = useTranslations('photos');
  const tKinds = useTranslations('photoKinds');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [myHubId, setMyHubId] = useState<string | null>(null);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [shipmentPhotos, setShipmentPhotos] = useState<ShipmentPhoto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [qrRaw, setQrRaw] = useState('');
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [otp, setOtp] = useState('');
  const [claimToken, setClaimToken] = useState('');
  const [integrityOk, setIntegrityOk] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectPhotos, setRejectPhotos] = useState<CapturedPhoto[]>([]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, dash] = await Promise.all([getShipment(id), getMyHubRequests()]);
      setDetail(d);
      setMyHubId(dash.hubId);
      setLoadError(null);
      // Best-effort: a photo listing failure must not hide the operations.
      getShipmentPhotos(id)
        .then((res) => setShipmentPhotos(res.photos))
        .catch(() => setShipmentPhotos([]));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    if (!sessionLoading && user) void load();
  }, [sessionLoading, user, load]);

  useEffect(() => {
    getHubs()
      .then((res) => setHubs(res.hubs))
      .catch(() => setHubs([]));
  }, []);

  if (sessionLoading) return <p className="muted">{tCommon('loading')}</p>;
  if (!user) {
    return (
      <div className="card stack-sm">
        <h1>{t('title')}</h1>
        <p className="muted">{tCommon('loginRequired')}</p>
        <Link className="btn btn-primary" href="/login">
          {tCommon('loginCta')}
        </Link>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="card stack-sm">
        <h1>{t('title')}</h1>
        <p className="field-error">{loadError}</p>
        <Link className="btn" href="/hub">
          {t('backToDashboard')}
        </Link>
      </div>
    );
  }
  if (!detail || !myHubId) return <p className="muted">{tCommon('loading')}</p>;

  const hubName = (hubId: string | null) =>
    hubId ? (hubs.find((h) => h.id === hubId)?.name ?? `${hubId.slice(0, 8)}…`) : '—';

  const qrToken = parseQrInput(qrRaw);
  const activeLeg = detail.legs.find((l) => l.status === 'picked_up');
  const isCustodian = detail.currentHubId === myHubId;

  /** Runs one handoff action; `fn` resolves to the success copy to show
   *  (the checkout needs a response-dependent message). */
  const run = async (fn: () => Promise<string>) => {
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      setNotice(await fn());
      setQrRaw('');
      setPhotos([]);
      setOtp('');
      setClaimToken('');
      setIntegrityOk(false);
      setShowReject(false);
      setRejectReason('');
      setRejectPhotos([]);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Uploads the certified bytes AFTER the transition landed (ADR-020 §3):
   *  a failure never voids the certification, the notice just says so. */
  const uploadCertified = async (list: CapturedPhoto[]): Promise<string> => {
    const failed = await uploadShipmentPhotos(id, list);
    return failed > 0 ? ` ${tPhotos('uploadFailed', { failed })}` : '';
  };

  const photoHashes = photos.map((p) => p.sha256);
  const rejectHashes = rejectPhotos.map((p) => p.sha256);

  // Parcel QR (ADR-021): the same tolerant text field as before, now with an
  // in-page camera scanner where the browser supports it. QrScanInput fills the
  // field with the raw scanned string; parseQrInput below stays the judge.
  const qrField = (
    <QrScanInput
      id="ops-qr"
      label={t('qrLabel')}
      hint={t('qrHint')}
      value={qrRaw}
      onChange={setQrRaw}
    />
  );

  const panel = (title: string, intro: string, form: ReactNode) => (
    <section className="card stack-sm">
      <h2>{title}</h2>
      <p className="muted small">{intro}</p>
      {form}
    </section>
  );

  // Which operation does the current state offer to THIS hub?
  let action: ReactNode = null;

  if (detail.status === 'DRAFT' && detail.originHubId === myHubId) {
    action = panel(
      t('acceptTitle'),
      t('acceptIntro'),
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await originAccept(detail.id);
            return t('acceptDone');
          })
        }
      >
        {t('acceptCta')}
      </button>,
    );
  } else if (detail.status === 'AWAITING_DROPOFF' && isCustodian) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        await originCheckin(detail.id, qrToken, photoHashes);
        return t('checkinDone') + (await uploadCertified(photos));
      });
    };
    action = panel(
      t('checkinTitle'),
      t('checkinIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        <PhotoHashInput id="ops-photos" photos={photos} onChange={setPhotos} />
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || photos.length === 0}
        >
          {t('checkinCta')}
        </button>
      </form>,
    );
  } else if (detail.status === 'LEG_BOOKED' && isCustodian) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        const res = await confirmCheckout(detail.id, qrToken, photoHashes);
        const base = res.complete ? t('checkoutComplete') : t('checkoutWaitingCarrier');
        // The checkout hashes are certifiable even while the double
        // confirmation is pending (ADR-020 §3): upload right away.
        return base + (await uploadCertified(photos));
      });
    };
    action = panel(
      t('checkoutTitle'),
      t('checkoutIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        <PhotoHashInput id="ops-photos" photos={photos} onChange={setPhotos} />
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || photos.length === 0}
        >
          {t('checkoutCta')}
        </button>
      </form>,
    );
  } else if (detail.status === 'IN_TRANSIT' && activeLeg && activeLeg.toHubId === myHubId) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        await legCheckin(detail.id, qrToken, photoHashes);
        return t('arrivalDone') + (await uploadCertified(photos));
      });
    };
    action = panel(
      t('arrivalTitle'),
      t('arrivalIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        <PhotoHashInput id="ops-photos" photos={photos} onChange={setPhotos} />
        <div className="checkbox-row">
          <input
            id="ops-integrity"
            type="checkbox"
            checked={integrityOk}
            onChange={(e) => setIntegrityOk(e.target.checked)}
          />
          <label htmlFor="ops-integrity">
            {t('integrityLabel')} <span className="hint">{t('integrityHint')}</span>
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || photos.length === 0 || !integrityOk}
        >
          {t('arrivalCta')}
        </button>
      </form>,
    );
  } else if (detail.status === 'IN_TRANSIT' && activeLeg && activeLeg.fromHubId === myHubId) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        await legReturn(detail.id, qrToken, photoHashes);
        return t('returnDone') + (await uploadCertified(photos));
      });
    };
    action = panel(
      t('returnTitle'),
      t('returnIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        <PhotoHashInput id="ops-photos" photos={photos} onChange={setPhotos} />
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || photos.length === 0}
        >
          {t('returnCta')}
        </button>
      </form>,
    );
  } else if (detail.status === 'AWAITING_PICKUP' && isCustodian) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        await recipientPickup(detail.id, qrToken, otp.trim());
        return t('pickupDone');
      });
    };
    action = panel(
      t('pickupTitle'),
      t('pickupIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        <div className="field">
          <label htmlFor="ops-otp">{t('otpLabel')}</label>
          <input
            id="ops-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
          />
          <span className="hint">{t('otpHint')}</span>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || otp.trim().length < 4}
        >
          {t('pickupCta')}
        </button>
      </form>,
    );
  } else if (detail.status === 'CLAIMED' && isCustodian) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        await claimedPickup(detail.id, qrToken, claimToken.trim());
        return t('claimedDone');
      });
    };
    action = panel(
      t('claimedTitle'),
      t('claimedIntro'),
      <form onSubmit={submit} className="stack-sm">
        {qrField}
        {/* The recipient shows the claim token as a QR of the bare token
            (ADR-016): scanning it fills the field with the token itself. */}
        <QrScanInput
          id="ops-claim-token"
          label={t('claimTokenLabel')}
          hint={t('claimTokenHint')}
          value={claimToken}
          onChange={setClaimToken}
        />
        <button
          className="btn btn-primary"
          disabled={busy || qrToken === '' || claimToken.trim() === ''}
        >
          {t('claimedCta')}
        </button>
      </form>,
    );
  }

  // Documentary reject (ADR-012): offered where THIS hub is the receiving
  // party — the arrival check-in, or the recipient's (claimed) pickup that
  // the custodian hub files on the recipient's behalf.
  let rejectStage: RejectStage | null = null;
  if (detail.status === 'IN_TRANSIT' && activeLeg && activeLeg.toHubId === myHubId) {
    rejectStage = 'hub_checkin';
  } else if (
    (detail.status === 'AWAITING_PICKUP' || detail.status === 'CLAIMED') &&
    isCustodian
  ) {
    rejectStage = 'recipient_pickup';
  }

  const submitReject = (e: FormEvent) => {
    e.preventDefault();
    const stage = rejectStage;
    if (!stage) return;
    void run(async () => {
      await rejectHandoff(detail.id, {
        stage,
        reason: rejectReason.trim(),
        photoSha256: rejectHashes,
      });
      return t('rejectDone') + (await uploadCertified(rejectPhotos));
    });
  };

  return (
    <div className="stack">
      <section>
        <div className="row-between">
          <div>
            <p className="muted">{t('title')}</p>
            <h1>
              <Codename value={detail.codename} className="codename-lg" />
            </h1>
          </div>
          <StatusBadge status={detail.status} />
        </div>
        <p className="muted">{tStatuses(statusDescriptionKey(detail.status))}</p>
        <p>
          <strong>
            {t('fromTo', {
              origin: hubName(detail.originHubId),
              dest: hubName(detail.destHubId),
            })}
          </strong>
        </p>
        <p className="small muted">
          {t('parcelLine', {
            l: detail.dims.lengthCm,
            w: detail.dims.widthCm,
            h: detail.dims.heightCm,
            g: detail.weightG,
          })}
          {detail.declaredContent ? ` · ${detail.declaredContent}` : ''}
          {detail.undeclared ? ` · ${t('undeclaredBadge')}` : ''}
        </p>
        <p className="small">
          {t('bondLine')}{' '}
          <Amount msat={detail.custodyBondMsat} satsPerEur={detail.eurRate.satsPerEur} />
        </p>
        <p className="small muted">{formatDateTime(detail.createdAt, locale)}</p>
      </section>

      {notice && (
        <p className="alert alert-success" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}

      {action ?? (
        <section className="card">
          <p className="muted">{t('nothingToDo')}</p>
        </section>
      )}

      {shipmentPhotos.length > 0 && (
        <section className="card stack-sm">
          <h2>{tPhotos('galleryTitle')}</h2>
          <p className="muted small">{tPhotos('galleryIntro')}</p>
          <div className="photo-strip">
            {shipmentPhotos.map((photo) => (
              <a
                key={photo.sha256}
                className="photo-cell"
                href={shipmentPhotoUrl(detail.id, photo.sha256)}
                target="_blank"
                rel="noreferrer"
                title={tPhotos('open')}
              >
                <img
                  className="photo-thumb"
                  src={shipmentPhotoUrl(detail.id, photo.sha256)}
                  alt={tKinds(photo.kind)}
                  loading="lazy"
                />
                <span className="badge badge-neutral">{tKinds(photo.kind)}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {rejectStage && (
        <section className="card stack-sm">
          <div className="row-between">
            <h2>{t('rejectTitle')}</h2>
            <button type="button" className="btn btn-sm" onClick={() => setShowReject(!showReject)}>
              {showReject ? tCommon('close') : t('rejectOpen')}
            </button>
          </div>
          <p className="muted small">{t('rejectIntro')}</p>
          {showReject && (
            <form onSubmit={submitReject} className="stack-sm">
              <div className="field">
                <label htmlFor="ops-reject-reason">{t('rejectReasonLabel')}</label>
                <textarea
                  id="ops-reject-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  maxLength={500}
                />
              </div>
              <PhotoHashInput id="ops-reject-photos" photos={rejectPhotos} onChange={setRejectPhotos} />
              <button
                className="btn btn-danger"
                disabled={busy || rejectReason.trim().length < 3 || rejectPhotos.length === 0}
              >
                {t('rejectCta')}
              </button>
            </form>
          )}
        </section>
      )}

      <Link className="btn no-print" href="/hub">
        {t('backToDashboard')}
      </Link>
    </div>
  );
}
