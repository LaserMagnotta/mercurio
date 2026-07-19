// Hub discovery (ADR-030): navigable map + viewport-bounded, distance-sorted
// list. The heavy lifting is client-side (Leaflet needs the browser); the
// server renders only the shell — the data is ALWAYS a bounded page, never
// the whole table, whatever the network grows to.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { HubsExplorer } from './HubsExplorer';

export default async function HubsPage() {
  const t = await getTranslations('hubs');

  return (
    <div className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <div className="card row-between">
        <span>{t('mineBody')}</span>
        <Link className="btn btn-sm" href="/hub">
          {t('mineCta')}
        </Link>
      </div>
      <HubsExplorer />
    </div>
  );
}
