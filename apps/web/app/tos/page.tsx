// Terms of Service (docs/legal/TOS.md rendered from the catalogs) — linked
// from the footer and from the GDPR consent step at first login.

import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LegalDocument } from '../../components/LegalDocument';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal');
  return { title: `${t('tos.title')} — Mercurio` };
}

export default function TosPage() {
  return <LegalDocument doc="tos" />;
}
