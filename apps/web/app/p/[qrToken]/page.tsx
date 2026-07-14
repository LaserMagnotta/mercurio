// Public parcel status by QR scan (ARCHITECTURE.md §7): whoever frames the
// QR sees at most status + origin/destination hub names. Server-rendered so
// a phone camera lands on meaningful content instantly.

import { getTranslations } from 'next-intl/server';
import { apiFetch, ApiError } from '../../../lib/api/client';
import type { ShipmentPublic } from '../../../lib/api/endpoints';
import { StatusBadge } from '../../../components/StatusBadge';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

export default async function PublicShipmentPage({
  params,
}: {
  params: Promise<{ qrToken: string }>;
}) {
  const { qrToken } = await params;
  const t = await getTranslations('shipment');
  const tStatuses = await getTranslations('statuses');

  let data: ShipmentPublic | null = null;
  try {
    data = await apiFetch<ShipmentPublic>(`/shipments/by-qr/${encodeURIComponent(qrToken)}`, {
      baseUrl: API_URL,
    });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }

  if (!data) {
    return (
      <div className="card">
        <h1>{t('title')}</h1>
        <p className="field-error">{t('notFound')}</p>
      </div>
    );
  }

  return (
    <div className="card stack-sm">
      <div className="row-between">
        <h1>{t('title')}</h1>
        <StatusBadge status={data.status} />
      </div>
      <p className="muted">{tStatuses(`${data.status}.description`)}</p>
      <p>
        <strong>{t('fromTo', { origin: data.originHubName, dest: data.destHubName })}</strong>
      </p>
    </div>
  );
}
