'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime } from '../lib/format';
import { recentShipments, type RecentShipment } from '../lib/recent';

export default function HomePage() {
  const t = useTranslations('home');
  const locale = useLocale();
  const [recent, setRecent] = useState<RecentShipment[]>([]);
  // localStorage is browser-only: read after mount to match SSR output.
  useEffect(() => {
    setRecent(recentShipments());
  }, []);

  return (
    <div className="stack">
      <section>
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </section>

      <section className="card">
        <h2>{t('sendTitle')}</h2>
        <p className="muted">{t('sendBody')}</p>
        <Link className="btn btn-primary" href="/send">
          {t('sendCta')}
        </Link>
      </section>

      <section className="card">
        <h2>{t('carrierTitle')}</h2>
        <p className="muted">{t('carrierBody')}</p>
        <Link className="btn" href="/carrier">
          {t('carrierCta')}
        </Link>
      </section>

      <section className="card">
        <h2>{t('hubsTitle')}</h2>
        <p className="muted">{t('hubsBody')}</p>
        <div className="row">
          <Link className="btn" href="/hubs">
            {t('hubsCta')}
          </Link>
          <Link className="btn" href="/hub">
            {t('hubMineCta')}
          </Link>
        </div>
      </section>

      <section>
        <h2>{t('recentTitle')}</h2>
        <p className="hint">{t('recentNote')}</p>
        {recent.length === 0 ? (
          <p className="muted">{t('recentEmpty')}</p>
        ) : (
          <ul className="list-plain">
            {recent.map((s) => (
              <li key={s.id} className="card row-between">
                <Link href={`/shipments/${s.id}`}>{s.id.slice(0, 8)}…</Link>
                <span className="muted small">{formatDateTime(s.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
