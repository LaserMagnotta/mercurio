'use client';

// The hub owner's home (CLAUDE.md "Hub — dettagli"): registration of the hub
// role for newcomers, the operational dashboard for registered hubs. One
// account, one hub (the API enforces it with a 409).

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useSession } from '../../lib/session';
import { HubRegisterForm } from './HubRegisterForm';
import { HubDashboard } from './HubDashboard';

export default function HubPage() {
  const t = useTranslations('hub');
  const tCommon = useTranslations('common');
  const { user, loading, refresh } = useSession();

  if (loading) return <p className="muted">{tCommon('loading')}</p>;
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

  return user.roles.hub ? <HubDashboard /> : <HubRegisterForm onRegistered={refresh} />;
}
