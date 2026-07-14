'use client';

// THE amount component (CLAUDE.md, ADR-008): sats are the true, unambiguous
// figure; EUR is an indicative secondary line derived from the exchange
// snapshot the API attached to the amount (frozen per shipment). No other
// component renders money.

import { useLocale, useTranslations } from 'next-intl';
import { formatEurIndicative, formatSats } from '../lib/format';

export interface AmountProps {
  /** msat amount as served by the API (decimal string). */
  msat: string;
  /** sats-per-EUR snapshot from the API; omit to render sats only. */
  satsPerEur?: string | null;
  size?: 'md' | 'lg';
  /** Pending-hold styling (Daily spending wallet: locked ≠ spent). */
  pending?: boolean;
}

export function Amount({ msat, satsPerEur, size = 'md', pending = false }: AmountProps) {
  const locale = useLocale();
  const t = useTranslations('common');
  const eur = formatEurIndicative(msat, satsPerEur, locale);
  const classes = ['amount', size === 'lg' && 'amount-lg', pending && 'amount-pending']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes}>
      <span className="amount-sats">
        {formatSats(msat, locale)} {t('sats')}
      </span>
      {eur !== null && (
        <span className="amount-eur" title={t('indicativeNote')}>
          ≈ {eur}
        </span>
      )}
    </span>
  );
}
