// Legal pages (/tos, /privacy): the full text lives in the message catalogs
// (ADR-018 §3 — zero hardcoded strings, and the parity test forces the
// English translation to exist). Canonical sources: docs/legal/TOS.md and
// docs/legal/PRIVACY.md — keep the catalogs in sync with them.

import { getTranslations } from 'next-intl/server';

interface LegalSection {
  title: string;
  body: string;
}

export async function LegalDocument({ doc }: { doc: 'tos' | 'privacy' }) {
  const t = await getTranslations('legal');
  const sections = t.raw(`${doc}.sections`) as LegalSection[];
  return (
    <article className="stack">
      <h1>{t(`${doc}.title`)}</h1>
      <p className="muted small">
        {t('versionLine', { version: t(`${doc}.version`) })} · {t('note')}
      </p>
      {sections.map((section) => (
        <section key={section.title} className="card stack-sm">
          <h2>{section.title}</h2>
          {section.body.split('\n\n').map((paragraph, i) => (
            // Single-newline runs inside a paragraph are list-style lines:
            // pre-line keeps them without a markdown renderer.
            <p key={i} className="legal-paragraph">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
      <p className="muted small">{t('operator')}</p>
    </article>
  );
}
