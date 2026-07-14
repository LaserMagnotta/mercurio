'use client';

// Wallet connection (ADR-013): every money-bearing role connects its OWN
// wallet — the platform can ask it to act, never dispose of its funds.
// Kinds: NWC (production roadmap — the API answers 501 for now), LND REST
// (dev/regtest nodes) and fake (dev-only, needs FAKE_WALLETS=true).

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  connectWallet,
  getWallet,
  type WalletConnection,
  type WalletKind,
} from '../../lib/api/endpoints';
import { useApiErrorMessage } from '../../lib/api-error-message';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/format';

export default function WalletPage() {
  const t = useTranslations('wallet');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { user, loading } = useSession();
  const errorMessage = useApiErrorMessage();

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [kind, setKind] = useState<WalletKind>('nwc');
  const [nwcString, setNwcString] = useState('');
  const [lndBaseUrl, setLndBaseUrl] = useState('');
  const [lndMacaroon, setLndMacaroon] = useState('');
  const [lndAllowInsecure, setLndAllowInsecure] = useState(true);
  const [fakeId, setFakeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!user) return;
    getWallet()
      .then((res) => setWallet(res.wallet))
      .catch(() => setWallet(null))
      .finally(() => setWalletLoaded(true));
  }, [user]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const connectionSecret =
      kind === 'nwc'
        ? nwcString
        : kind === 'lnd_rest'
          ? JSON.stringify({
              baseUrl: lndBaseUrl,
              macaroonHex: lndMacaroon,
              allowInsecure: lndAllowInsecure,
            })
          : fakeId;
    setBusy(true);
    try {
      await connectWallet(kind, connectionSecret);
      const res = await getWallet();
      setWallet(res.wallet);
      setSuccess(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>

      {walletLoaded && (
        <div className={`alert ${wallet ? 'alert-success' : 'alert-warning'}`}>
          {wallet ? (
            <>
              <strong>{t('connected')}</strong> — {t(`kinds.${wallet.kind}`)}{' '}
              <span className="muted small">({formatDateTime(wallet.createdAt, locale)})</span>
            </>
          ) : (
            t('none')
          )}
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="kind">{t('kindLabel')}</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as WalletKind)}>
            <option value="nwc">{t('kinds.nwc')}</option>
            <option value="lnd_rest">{t('kinds.lnd_rest')}</option>
            <option value="fake">{t('kinds.fake')}</option>
          </select>
        </div>

        {kind === 'nwc' && (
          <div className="field">
            <label htmlFor="nwc">{t('nwcSecretLabel')}</label>
            <input
              id="nwc"
              type="text"
              value={nwcString}
              onChange={(e) => setNwcString(e.target.value)}
              required
            />
            <span className="hint">{t('nwcHint')}</span>
          </div>
        )}

        {kind === 'lnd_rest' && (
          <>
            <div className="field">
              <label htmlFor="lnd-url">{t('lndBaseUrl')}</label>
              <input
                id="lnd-url"
                type="url"
                value={lndBaseUrl}
                onChange={(e) => setLndBaseUrl(e.target.value)}
                required
              />
              <span className="hint">{t('lndHint')}</span>
            </div>
            <div className="field">
              <label htmlFor="lnd-macaroon">{t('lndMacaroon')}</label>
              <input
                id="lnd-macaroon"
                type="text"
                value={lndMacaroon}
                onChange={(e) => setLndMacaroon(e.target.value)}
                required
              />
            </div>
            <div className="checkbox-row">
              <input
                id="lnd-insecure"
                type="checkbox"
                checked={lndAllowInsecure}
                onChange={(e) => setLndAllowInsecure(e.target.checked)}
              />
              <label htmlFor="lnd-insecure">{t('lndAllowInsecure')}</label>
            </div>
          </>
        )}

        {kind === 'fake' && (
          <div className="field">
            <label htmlFor="fake-id">{t('fakeSecretLabel')}</label>
            <input
              id="fake-id"
              type="text"
              value={fakeId}
              onChange={(e) => setFakeId(e.target.value)}
              required
            />
            <span className="hint">{t('fakeHint')}</span>
          </div>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="alert alert-success" role="status">
            {t('success')}
          </p>
        )}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('connecting') : t('submit')}
        </button>
        <p className="hint">{t('replaceNote')}</p>
      </form>
    </div>
  );
}
