// Public profile page (ADR-017: "i rating sono informazione di mercato"):
// per-role aggregates computed by the DB on read, plus the received reviews
// newest first. Server-rendered like the other public pages — the server
// talks to the API directly (the /api rewrite exists for browsers).

import { getLocale, getTranslations } from 'next-intl/server';
import { apiFetch, ApiError } from '../../../lib/api/client';
import type { UserReviews } from '../../../lib/api/endpoints';
import { RatingStars } from '../../../components/RatingStars';
import { formatDateTime } from '../../../lib/format';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

export default async function UserProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('profile');
  const tRoles = await getTranslations('roles');
  const locale = await getLocale();

  let data: UserReviews | null = null;
  try {
    data = await apiFetch<UserReviews>(`/users/${encodeURIComponent(id)}/reviews`, {
      baseUrl: API_URL,
    });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }

  if (!data) {
    return (
      <div className="card">
        <h1>{t('title')}</h1>
        <p className="field-error">{t('notFound')}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <section>
        <h1>{t('title')}</h1>
        <p className="muted small">{t('idLine', { id: `${data.userId.slice(0, 8)}…` })}</p>
      </section>

      <section className="card stack-sm">
        <h2>{t('ratingsTitle')}</h2>
        {/* Only the hub is reviewable (ADR-027): one aggregate. */}
        <div className="row-between">
          <span>{tRoles('hub')}</span>
          <RatingStars rating={data.ratings.hub} />
        </div>
        <p className="hint">{t('ratingsHint')}</p>
      </section>

      <section className="card stack-sm">
        <h2>{t('reviewsTitle')}</h2>
        {data.reviews.length === 0 ? (
          <p className="muted">{t('reviewsEmpty')}</p>
        ) : (
          <ul className="list-plain">
            {data.reviews.map((review) => (
              <li key={review.id} className="stack-sm">
                <div className="row-between">
                  <span className="rating" aria-label={t('starsAria', { stars: review.stars })}>
                    <span aria-hidden="true">
                      <span className="rating-star">{'★'.repeat(review.stars)}</span>
                      {'☆'.repeat(5 - review.stars)}
                    </span>
                  </span>
                  <span className="badge badge-neutral">{tRoles(review.role)}</span>
                </div>
                {review.comment && <p>{review.comment}</p>}
                <p className="muted small">{formatDateTime(review.createdAt, locale)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
