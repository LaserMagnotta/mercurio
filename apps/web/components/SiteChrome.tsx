'use client';

// App shell: sticky header (brand + auth state), tab navigation (bottom bar
// on mobile, top bar from 700px) and footer with the language switcher.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSession } from '../lib/session';
import { Icon, type IconName } from './Icon';

const LOCALE_COOKIE = 'MERCURIO_LOCALE';

export function SiteHeader() {
  const t = useTranslations('nav');
  const { user, loading, logout } = useSession();
  const router = useRouter();
  return (
    <header className="app-header no-print">
      <div className="app-header-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="mercury" />
          </span>
          Mercurio
        </Link>
        {!loading &&
          (user ? (
            <span className="row small">
              {/* The email doubles as the door to the account/GDPR page. */}
              <Link href="/account" className="muted" title={t('account')}>
                {user.email}
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void logout().then(() => router.push('/'));
                }}
              >
                {t('logout')}
              </button>
            </span>
          ) : (
            <Link href="/login" className="btn btn-sm">
              {t('login')}
            </Link>
          ))}
      </div>
    </header>
  );
}

const NAV_ITEMS: ReadonlyArray<{ href: string; key: string; icon: IconName }> = [
  { href: '/', key: 'home', icon: 'home' },
  { href: '/send', key: 'send', icon: 'parcel' },
  { href: '/carrier', key: 'carrier', icon: 'car' },
  { href: '/hubs', key: 'hubs', icon: 'storefront' },
  { href: '/wallet', key: 'wallet', icon: 'bolt' },
] as const;

export function SiteNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  return (
    <nav className="app-nav no-print" aria-label="Mercurio">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isCurrent(item.href) ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">
            <Icon name={item.icon} />
          </span>
          {t(item.key)}
        </Link>
      ))}
    </nav>
  );
}

export function SiteFooter() {
  const t = useTranslations('common');
  const router = useRouter();
  const switchLocale = () => {
    const current = document.cookie.includes(`${LOCALE_COOKIE}=en`) ? 'en' : 'it';
    const next = current === 'it' ? 'en' : 'it';
    document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  };
  return (
    <footer className="app-footer no-print">
      <span>{t('tagline')}</span>
      <span className="row">
        <Link href="/tos">{t('tosLink')}</Link>
        <Link href="/privacy">{t('privacyLink')}</Link>
        <button type="button" className="link-button" onClick={switchLocale}>
          {t('switchLanguage')}
        </button>
      </span>
    </footer>
  );
}
