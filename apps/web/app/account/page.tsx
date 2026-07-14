'use client';

// Account & GDPR page (CLAUDE.md "Conformità privacy"): who you are, your
// roles, the public profile link, the data export (right to portability —
// one JSON document, downloaded client-side) and the account erasure. The
// API anonymizes rather than deletes (the ledger and the custody chain are
// append-only and PII-free): the copy says so honestly.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { deleteMyAccount, exportMyData } from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { useSession } from '../../lib/session';

export default function AccountPage() {
  const t = useTranslations('account');
  const tCommon = useTranslations('common');
  const tRoles = useTranslations('roles');
  const router = useRouter();
  const { user, loading, refresh } = useSession();
  const errorMessage = useApiErrorMessage();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (loading) return <p className="muted">{tCommon('loading')}</p>;
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

  const roles = [
    t('roleSender'),
    ...(user.roles.carrier ? [tRoles('carrier')] : []),
    ...(user.roles.hub ? [tRoles('hub')] : []),
  ];

  const downloadExport = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const data = await exportMyData();
      // Client-side download: the document never touches any third party.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mercurio-export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteMyAccount();
      await refresh(); // the session cookie is gone: back to anonymous
      router.push('/');
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('title')}</h1>

      <section className="card stack-sm">
        <dl className="kv">
          <dt>{t('emailLabel')}</dt>
          <dd>{user.email}</dd>
          <dt>{t('rolesLabel')}</dt>
          <dd>{roles.join(' · ')}</dd>
        </dl>
        <Link className="btn btn-sm" href={`/users/${user.id}`}>
          {t('publicProfile')}
        </Link>
      </section>

      <section className="card stack-sm">
        <h2>{t('exportTitle')}</h2>
        <p className="muted small">{t('exportBody')}</p>
        {exportError && (
          <p className="field-error" role="alert">
            {exportError}
          </p>
        )}
        <button
          type="button"
          className="btn"
          disabled={exporting}
          onClick={() => void downloadExport()}
        >
          {exporting ? t('exporting') : t('exportCta')}
        </button>
      </section>

      <section className="card stack-sm">
        <div className="row-between">
          <h2>{t('deleteTitle')}</h2>
          <button type="button" className="btn btn-sm" onClick={() => setShowDelete(!showDelete)}>
            {showDelete ? tCommon('close') : t('deleteOpen')}
          </button>
        </div>
        <p className="muted small">{t('deleteBody')}</p>
        {showDelete && (
          <div className="stack-sm">
            <div className="checkbox-row">
              <input
                id="confirm-delete"
                type="checkbox"
                checked={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.checked)}
              />
              <label htmlFor="confirm-delete">{t('deleteConfirmLabel')}</label>
            </div>
            {deleteError && (
              <p className="field-error" role="alert">
                {deleteError}
              </p>
            )}
            <button
              type="button"
              className="btn btn-danger"
              disabled={!confirmDelete || deleting}
              onClick={() => void deleteAccount()}
            >
              {deleting ? t('deleting') : t('deleteCta')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
