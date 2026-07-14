// Public hub list, server-rendered (ADR-002: SSR for public pages). The
// server talks to the API directly — the /api rewrite exists for browsers.

import { getTranslations } from 'next-intl/server';
import { apiFetch } from '../../lib/api/client';
import type { Hub } from '../../lib/api/endpoints';
import { HubCard } from '../../components/HubCard';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

export default async function HubsPage() {
  const t = await getTranslations('hubs');
  let hubs: Hub[] = [];
  let failed = false;
  try {
    hubs = (await apiFetch<{ hubs: Hub[] }>('/hubs', { baseUrl: API_URL })).hubs;
  } catch {
    failed = true;
  }
  const tCommon = await getTranslations('common');

  return (
    <div className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      {failed && <p className="alert alert-danger">{tCommon('error')}</p>}
      {!failed && hubs.length === 0 && <p className="muted">{t('empty')}</p>}
      <div className="list-plain">
        {hubs.map((hub) => (
          <HubCard key={hub.id} hub={hub} />
        ))}
      </div>
    </div>
  );
}
