// Privacy policy (docs/legal/PRIVACY.md rendered from the catalogs) — linked
// from the footer, from the GDPR consent step and from every lifecycle email
// (art. 14/21 GDPR, RISKS.md §6).

import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LegalDocument } from '../../components/LegalDocument';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal');
  return { title: `${t('privacy.title')} — Mercurio` };
}

export default function PrivacyPage() {
  return <LegalDocument doc="privacy" />;
}
