// Public hub detail (ADR-030): the full hub card server-rendered, plus the
// client section with the shipments waiting HERE for a carrier — reverse
// trip planning: first you find the hub on your way, then you declare the
// trip that passes by it.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '../../../lib/api/client';
import type { Hub } from '../../../lib/api/endpoints';
import { HubCard } from '../../../components/HubCard';
import { WaitingShipments } from './WaitingShipments';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

export default async function HubDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('hubs');
  let hub: Hub;
  try {
    hub = await apiFetch<Hub>(`/hubs/${id}`, { baseUrl: API_URL });
  } catch {
    notFound();
  }

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{hub.name}</h1>
        <Link className="btn btn-sm" href="/hubs">
          {t('backToHubs')}
        </Link>
      </div>
      <HubCard hub={hub} />
      <WaitingShipments hubId={hub.id} hubName={hub.name} />
    </div>
  );
}
