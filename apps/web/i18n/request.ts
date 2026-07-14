// next-intl request config WITHOUT locale routing: the UI is Italian by
// default with English ready (CLAUDE.md), so a cookie — not the URL — carries
// the locale. Adding en-prefixed routes later is a routing change only; every
// string already lives in messages/*.json.

import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

export const LOCALES = ['it', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'it';

/** Cookie read here and written by the client-side language switcher. */
export const LOCALE_COOKIE = 'MERCURIO_LOCALE';

export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = (LOCALES as readonly string[]).includes(requested ?? '')
    ? (requested as Locale)
    : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
