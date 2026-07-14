'use client';

import { useTranslations } from 'next-intl';
import { SHIPMENT_STATUS_TONE, statusLabelKey, type ShipmentState } from '../lib/shipment-status';

export function StatusBadge({ status }: { status: ShipmentState }) {
  const t = useTranslations('statuses');
  return (
    <span className={`badge badge-${SHIPMENT_STATUS_TONE[status]}`}>
      {t(statusLabelKey(status))}
    </span>
  );
}
