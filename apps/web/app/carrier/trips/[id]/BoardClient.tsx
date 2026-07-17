'use client';

// The ranked board (MATCHING.md §3): "Per te" (matches, surplus-descending)
// on top, "Altre" below — still visible because the minimum rate is a
// preference, not a contract. Every card shows the FROZEN numbers the
// acceptance would freeze (net + indicative € at the shipment's own
// snapshot, the delivery bonus as its own line — ADR-014), the detour, the
// bond, the parcel and the ratings of every counterparty (ADR-017).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  acceptLeg,
  getBoard,
  type BoardCard,
  type LegPricing,
} from '../../../../lib/api/endpoints';
import { ApiError } from '../../../../lib/api/client';
import { useApiErrorMessage } from '../../../../lib/api-error-message';
import { useSession } from '../../../../lib/session';
import { formatDateTime, formatKm } from '../../../../lib/format';
import { Amount } from '../../../../components/Amount';
import { Codename } from '../../../../components/Codename';
import { RatingStars } from '../../../../components/RatingStars';

type DropOption = BoardCard['bestDropHub'];

interface AcceptTarget {
  card: BoardCard;
  option: DropOption;
}

interface Accepted {
  card: BoardCard;
  option: DropOption;
  pricing: LegPricing;
  fundingDeadlineAt: string;
}

export function BoardClient({ tripId }: { tripId: string }) {
  const t = useTranslations('board');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { user, loading: sessionLoading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<AcceptTarget | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getBoard(tripId);
      setCards(res.cards);
      setLoadError(null);
    } catch (err) {
      setCards([]);
      setLoadError(errorMessage(err));
    }
  }, [tripId]);

  useEffect(() => {
    if (!sessionLoading && user) void load();
  }, [sessionLoading, user, load]);

  if (sessionLoading) return <p className="muted">{tCommon('loading')}</p>;
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

  const confirmAccept = async () => {
    if (!target) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await acceptLeg(target.card.shipmentId, tripId, target.option.hubId);
      setAccepted({
        card: target.card,
        option: target.option,
        pricing: res.pricing,
        fundingDeadlineAt: res.fundingDeadlineAt,
      });
      setTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? errorMessage(err) : tCommon('error'));
    } finally {
      setBusy(false);
    }
  };

  const optionRow = (card: BoardCard, option: DropOption, isBest: boolean) => (
    <div key={option.hubId} className={isBest ? 'stack-sm' : 'stack-sm card'}>
      <div className="row-between">
        <span>
          <strong>{t('toProposed', { hub: option.hubName })}</strong>{' '}
          {option.hubId === card.destHubId && (
            <span className="badge badge-info">{t('destinationFinal')}</span>
          )}
        </span>
        <RatingStars rating={option.hubRating} />
      </div>
      <dl className="kv small">
        <dt>{t('net')}</dt>
        <dd>
          <Amount msat={option.netMsat} satsPerEur={card.eurRate.satsPerEur} size="lg" />
        </dd>
        {option.finalizationBonusMsat !== '0' && (
          <>
            <dt>{t('bonusLine')}</dt>
            <dd>
              <Amount msat={option.finalizationBonusMsat} satsPerEur={card.eurRate.satsPerEur} />
            </dd>
          </>
        )}
        <dt>{t('detour')}</dt>
        <dd>{formatKm(option.detourKm, locale)}</dd>
      </dl>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            setAccepted(null);
            setTarget({ card, option });
          }}
        >
          {t('accept')}
        </button>
        <Link
          className="btn btn-sm"
          href={`/carrier/trips/${tripId}/route?previewShipmentId=${card.shipmentId}&previewDropHubId=${option.hubId}`}
        >
          {t('preview')}
        </Link>
      </div>
    </div>
  );

  const renderCard = (card: BoardCard) => (
    <article
      key={card.shipmentId}
      className={`card stack-sm${card.isMatch ? ' card-highlight' : ''}`}
    >
      <div className="row-between">
        <Codename value={card.codename} />
        <span className="muted small">
          {t('remainingOfTotal', {
            remaining: formatKm(card.remainingKm, locale),
            total: formatKm(card.totalKm, locale),
          })}
        </span>
      </div>
      <strong>{t('from', { hub: card.currentHubName })}</strong>
      <p className="row small">
        <span className="muted">
          {t('parcel', {
            l: card.dims.lengthCm,
            w: card.dims.widthCm,
            h: card.dims.heightCm,
            g: card.weightG,
          })}
        </span>
        {card.undeclared && <span className="badge badge-warning">{t('undeclared')}</span>}
      </p>
      <p className="row small">
        {/* Only hubs are reviewable now (ADR-027): no sender rating. */}
        <span className="muted">{t('hubRating')}:</span>
        <RatingStars rating={card.currentHubRating} />
      </p>
      <dl className="kv small">
        <dt>{t('bond')}</dt>
        <dd>
          <Amount msat={card.custodyBondMsat} satsPerEur={card.eurRate.satsPerEur} />
        </dd>
      </dl>

      {optionRow(card, card.bestDropHub, true)}

      {card.alternatives.length > 0 && (
        <details>
          <summary>{t('alternatives')}</summary>
          <div className="stack-sm">
            {card.alternatives.map((alt) => optionRow(card, alt, false))}
          </div>
        </details>
      )}
    </article>
  );

  const matches = (cards ?? []).filter((c) => c.isMatch);
  const others = (cards ?? []).filter((c) => !c.isMatch);

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t('title')}</h1>
        <div className="row">
          <Link className="btn btn-sm" href={`/carrier/trips/${tripId}/route`}>
            {t('viewRoute')}
          </Link>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            {t('refresh')}
          </button>
        </div>
      </div>

      {loadError && (
        <p className="alert alert-danger" role="alert">
          {loadError}
        </p>
      )}

      {accepted && (
        <div className="alert alert-success stack-sm" role="status">
          <div className="row-between">
            <strong>{t('acceptedTitle')}</strong>
            <Codename value={accepted.card.codename} />
          </div>
          <p className="small">
            {t('acceptedBody', {
              time: formatDateTime(accepted.fundingDeadlineAt, locale),
            })}
          </p>
          <p>
            {t('acceptedNet')}:{' '}
            <Amount
              msat={accepted.pricing.netMsat}
              satsPerEur={accepted.card.eurRate.satsPerEur}
              size="lg"
            />
          </p>
          {accepted.pricing.finalizationBonusMsat !== '0' && (
            <p className="small">
              + {t('bonusLine')}:{' '}
              <Amount
                msat={accepted.pricing.finalizationBonusMsat}
                satsPerEur={accepted.card.eurRate.satsPerEur}
              />
            </p>
          )}
          <div className="row">
            <Link className="btn btn-sm" href={`/shipments/${accepted.card.shipmentId}`}>
              {t('viewShipment')}
            </Link>
            <Link className="btn btn-sm" href={`/carrier/trips/${tripId}/route`}>
              {t('viewRoute')}
            </Link>
          </div>
        </div>
      )}

      {target && (
        <div className="card card-highlight stack-sm">
          <h2>{t('acceptTitle')}</h2>
          <p>
            {t('acceptBody', {
              from: target.card.currentHubName,
              to: target.option.hubName,
            })}
          </p>
          <dl className="kv">
            <dt>{t('net')}</dt>
            <dd>
              <Amount
                msat={target.option.netMsat}
                satsPerEur={target.card.eurRate.satsPerEur}
                size="lg"
              />
            </dd>
            {target.option.finalizationBonusMsat !== '0' && (
              <>
                <dt>{t('bonusLine')}</dt>
                <dd>
                  <Amount
                    msat={target.option.finalizationBonusMsat}
                    satsPerEur={target.card.eurRate.satsPerEur}
                  />
                </dd>
              </>
            )}
            <dt>{t('bond')}</dt>
            <dd>
              <Amount
                msat={target.card.custodyBondMsat}
                satsPerEur={target.card.eurRate.satsPerEur}
              />
            </dd>
            <dt>{t('detour')}</dt>
            <dd>{formatKm(target.option.detourKm, locale)}</dd>
          </dl>
          {actionError && (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void confirmAccept()}
            >
              {busy ? t('accepting') : t('acceptConfirm')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setTarget(null)}>
              {tCommon('cancel')}
            </button>
          </div>
        </div>
      )}

      {cards === null ? (
        <p className="muted">{tCommon('loading')}</p>
      ) : cards.length === 0 && !loadError ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <>
          <section>
            <h2>{t('forYou')}</h2>
            {matches.length === 0 ? (
              <p className="muted">{t('forYouEmpty')}</p>
            ) : (
              <div className="list-plain">{matches.map(renderCard)}</div>
            )}
          </section>
          <section>
            <h2>{t('others')}</h2>
            {others.length === 0 ? (
              <p className="muted">{t('othersEmpty')}</p>
            ) : (
              <div className="list-plain">{others.map(renderCard)}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
