import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { SessionProvider } from '../lib/session';
import { SiteFooter, SiteHeader, SiteNav } from '../components/SiteChrome';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');
  return { title: t('appName'), description: t('tagline') };
}

// UI in Italian by default, English ready (CLAUDE.md): the locale comes from
// the request config (cookie, `it` fallback) — no locale URLs needed yet.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <SessionProvider>
            <div className="app-shell">
              <SiteHeader />
              <SiteNav />
              <main className="app-main">{children}</main>
              <SiteFooter />
            </div>
          </SessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
