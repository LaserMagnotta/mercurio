'use client';

// Review form (CLAUDE.md "Recensioni", ADR-017): shown on CLOSED shipments
// only, to the effective participants, about the effective participants —
// the `ratings` array of the detail DTO is exactly that set, so the client
// offers only legal (subject, role) pairs and the API stays the judge
// (window, authorship, duplicates → mapped error copy).

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { createReview, type ShipmentDetail } from '../../../lib/api/endpoints';
import { useApiErrorMessage } from '../../../lib/api-error-message';
import { isTerminal } from '../../../lib/shipment-status';

const STARS = [1, 2, 3, 4, 5] as const;

export function ReviewsSection({
  detail,
  userId,
  hubName,
}: {
  detail: ShipmentDetail;
  userId: string;
  hubName: (hubId: string | null) => string;
}) {
  const t = useTranslations('reviews');
  const tRoles = useTranslations('roles');
  const errorMessage = useApiErrorMessage();

  const [subjectKey, setSubjectKey] = useState('');
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());

  // (subject, role) pairs this user may review: every effective participant
  // but themselves. The key encodes both — one user can hold two roles.
  const subjects = useMemo(
    () =>
      detail.ratings
        .filter((p) => p.userId !== userId)
        .map((p) => ({
          key: `${p.userId}:${p.role}`,
          userId: p.userId,
          role: p.role,
          hubId: p.hubId,
        })),
    [detail.ratings, userId],
  );

  const isAuthor = detail.ratings.some((p) => p.userId === userId);
  if (!isTerminal(detail.status) || !isAuthor || subjects.length === 0) return null;

  const subjectLabel = (s: (typeof subjects)[number]) =>
    s.hubId
      ? `${tRoles(s.role)} — ${hubName(s.hubId)}`
      : `${tRoles(s.role)} — ${s.userId.slice(0, 8)}…`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const subject = subjects.find((s) => s.key === subjectKey);
    if (!subject || stars === 0) return;
    setError(null);
    setBusy(true);
    createReview(detail.id, {
      subjectId: subject.userId,
      role: subject.role,
      stars,
      ...(comment.trim() !== '' && { comment: comment.trim() }),
    })
      .then(() => {
        setSubmitted(new Set(submitted).add(subject.key));
        setSubjectKey('');
        setStars(0);
        setComment('');
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card stack-sm no-print">
      <h2>{t('title')}</h2>
      <p className="muted small">{t('intro')}</p>

      {submitted.size > 0 && (
        <p className="alert alert-success" role="status">
          {t('done')}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="stack-sm">
        <div className="field">
          <label htmlFor="review-subject">{t('subjectLabel')}</label>
          <select
            id="review-subject"
            value={subjectKey}
            onChange={(e) => setSubjectKey(e.target.value)}
          >
            <option value="">{t('subjectPick')}</option>
            {subjects.map((s) => (
              <option key={s.key} value={s.key} disabled={submitted.has(s.key)}>
                {subjectLabel(s)}
                {submitted.has(s.key) ? ` — ${t('alreadySent')}` : ''}
              </option>
            ))}
          </select>
        </div>

        <fieldset>
          <legend>{t('starsLabel')}</legend>
          <div className="row" role="radiogroup" aria-label={t('starsLabel')}>
            {STARS.map((n) => (
              <button
                key={n}
                type="button"
                className={`btn btn-sm ${stars >= n ? 'btn-primary' : ''}`}
                aria-pressed={stars === n}
                aria-label={t('starsAria', { n })}
                onClick={() => setStars(n)}
              >
                {stars >= n ? '★' : '☆'}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="review-comment">{t('commentLabel')}</label>
          <textarea
            id="review-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
          />
          <span className="hint">{t('commentHint')}</span>
        </div>

        <button className="btn btn-primary" disabled={busy || subjectKey === '' || stars === 0}>
          {busy ? t('submitting') : t('submit')}
        </button>
      </form>
    </section>
  );
}
