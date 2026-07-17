'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime } from '../lib/format';
import { getMyShipments, type MeShipments } from '../lib/api/endpoints';
import { useApiErrorMessage } from '../lib/api-error-message';
import { useSession } from '../lib/session';
import { Amount } from '../components/Amount';
import { Codename } from '../components/Codename';
import { StatusBadge } from '../components/StatusBadge';

const PAGE_SIZE = 5;

export default function HomePage() {
  const t = useTranslations('home');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [items, setItems] = useState<MeShipments['items']>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getMyShipments({ limit: PAGE_SIZE, offset: items.length });
      setItems((prev) => [...prev, ...res.items]);
      setTotal(res.total);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [items.length]);

  useEffect(() => {
    if (!user) return;
    void loadMore();
    // Deliberately keyed on `user` alone: loadMore's identity churns with
    // items.length and must not re-trigger this initial load.
  }, [user]);

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
        {!sessionLoading && !user && (
          <div className="card stack-sm">
            <p className="muted">{tCommon('loginRequired')}</p>
            <Link className="btn btn-primary" href="/login">
              {tCommon('loginCta')}
            </Link>
          </div>
        )}
        {user && (
          <>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            {items.length === 0 && !loading ? (
              <p className="muted">{t('recentEmpty')}</p>
            ) : (
              <ul className="list-plain">
                {items.map((s) => (
                  <li key={s.id} className="card stack-sm">
                    <div className="row-between">
                      <Codename value={s.codename} />
                      <StatusBadge status={s.status} />
                    </div>
                    <p className="small">
                      {t('routeLine', { origin: s.originHubName, dest: s.destHubName })}
                    </p>
                    <span className="muted small">{formatDateTime(s.createdAt, locale)}</span>
                    <div className="row-between">
                      <Amount msat={s.offerMsat} />
                      <Link className="btn btn-sm" href={`/shipments/${s.id}`}>
                        {t('openShipment')}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {items.length < total && (
              <button type="button" className="btn btn-sm" disabled={loading} onClick={loadMore}>
                {loading ? tCommon('loading') : t('loadMore')}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
