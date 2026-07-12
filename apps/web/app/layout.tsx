import type { ReactNode } from 'react';

export const metadata = {
  title: 'Mercurio',
  description: 'Rete logistica peer-to-peer su Lightning',
};

// UI language is Italian (i18n-ready via next-intl, ADR-011 in CLAUDE.md rules).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
