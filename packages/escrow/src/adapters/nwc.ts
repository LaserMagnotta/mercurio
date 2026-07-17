// NWC (Nostr Wallet Connect, NIP-47) adapter — ADR-019 closes the ADR-013
// roadmap item. Maps WalletConnection onto NIP-47's hold-invoice extension
// methods (make_hold_invoice / settle_hold_invoice / cancel_hold_invoice),
// which are NOT part of the NIP-47 base spec but are a documented, merged
// extension implemented by hold-invoice-capable wallet services (Alby Hub —
// ADR-019 §2). A wallet lacking them can still connect (capabilities.holdInvoice
// = false); the resolver in apps/api/src/lib/wallets.ts refuses to hand out
// such a wallet for any money-bearing role (ADR-019 §4).

import {
  getPublicKeyHex,
  signEvent,
  type NostrEvent,
  type UnsignedNostrEvent,
} from '../nostr/event.js';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04.js';
import { nip44Decrypt, nip44Encrypt } from '../nostr/nip44.js';
import {
  NwcRelayError,
  NwcTimeoutError,
  WebSocketNwcTransport,
  type NostrFilter,
  type NwcTransport,
} from '../nostr/relay.js';
import type { Hex, InvoiceState, WalletConnection } from '../types.js';

export type { NwcTransport } from '../nostr/relay.js';
import { extractPaymentHash } from './bolt11.js';

const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;

export type NwcEncryption = 'nip44_v2' | 'nip04';

export interface NwcConnectionParams {
  /** x-only (32-byte) hex pubkey of the wallet service. */
  walletPubkey: string;
  /** Relay URLs to try, in order (ADR-019 §3: first reachable wins). */
  relays: string[];
  /** x-only (32-byte) hex secret key this CLIENT signs/encrypts with. */
  clientSecretKey: string;
  lud16?: string;
}

export class NwcUriError extends Error {}

/** Parses `nostr+walletconnect://<wallet-pubkey>?relay=...&secret=...`. */
export function parseNwcUri(uri: string): NwcConnectionParams {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new NwcUriError('nwc: not a valid URI');
  }
  if (url.protocol !== 'nostr+walletconnect:') {
    throw new NwcUriError(`nwc: expected scheme "nostr+walletconnect://", got "${url.protocol}//"`);
  }
  const walletPubkey = url.hostname;
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new NwcUriError('nwc: wallet pubkey must be 64 lowercase hex chars');
  }
  const relays = url.searchParams.getAll('relay').filter((r) => r.length > 0);
  if (relays.length === 0) {
    throw new NwcUriError('nwc: connection string has no relay= parameter');
  }
  for (const relay of relays) {
    let relayUrl: URL;
    try {
      relayUrl = new URL(relay);
    } catch {
      throw new NwcUriError(`nwc: invalid relay URL "${relay}"`);
    }
    if (relayUrl.protocol !== 'ws:' && relayUrl.protocol !== 'wss:') {
      throw new NwcUriError(`nwc: relay URL must be ws:// or wss:// ("${relay}")`);
    }
  }
  const clientSecretKey = url.searchParams.get('secret') ?? '';
  if (!/^[0-9a-f]{64}$/.test(clientSecretKey)) {
    throw new NwcUriError('nwc: secret must be 64 lowercase hex chars');
  }
  const lud16 = url.searchParams.get('lud16');
  return { walletPubkey, relays, clientSecretKey, ...(lud16 && { lud16 }) };
}

/** A NIP-47 error reply, or a transport-level failure translated to the same
 *  shape so callers only ever deal with one error type. */
export class NwcRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NwcRpcError';
  }
}

interface NwcRpcReply<T> {
  result_type?: string;
  error?: { code: string; message: string } | null;
  result?: T | null;
}

export interface NwcWalletOptions {
  encryption: NwcEncryption;
  /** Injectable for tests (in-process fake relay); defaults to a real
   *  per-call WebSocket connection (ADR-019 §3). */
  transportFactory?: (relays: string[]) => NwcTransport;
  /** Per-call RPC timeout, except payInvoice (see payInvoiceTimeoutMs). */
  timeoutMs?: number;
  /** ADR-019 §5 (accepted gap): NIP-47's pay_invoice has no "dispatched"
   *  interim reply, so paying a HOLD invoice may keep this pending for as
   *  long as the wallet service's own payment stays in flight. Generous by
   *  default; still bounded so a truly stuck call cannot hang forever. */
  payInvoiceTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAY_INVOICE_TIMEOUT_MS = 90_000;

export class NwcWallet implements WalletConnection {
  private readonly clientPubkey: string;

  constructor(
    private readonly params: NwcConnectionParams,
    private readonly opts: NwcWalletOptions,
  ) {
    this.clientPubkey = getPublicKeyHex(params.clientSecretKey);
  }

  async makeHoldInvoice(
    amountMsat: bigint,
    hash: Hex,
    expirySeconds: number,
    memo: string,
  ): Promise<{ bolt11: string }> {
    const result = await this.call<{ invoice: string }>('make_hold_invoice', {
      amount: msatToNumber(amountMsat),
      description: memo,
      payment_hash: hash,
      expiry: expirySeconds,
    });
    return { bolt11: result.invoice };
  }

  async makeInvoice(
    amountMsat: bigint,
    memo: string,
  ): Promise<{ bolt11: string; paymentHash: Hex }> {
    const result = await this.call<{ invoice: string; payment_hash: string }>('make_invoice', {
      amount: msatToNumber(amountMsat),
      description: memo,
    });
    return { bolt11: result.invoice, paymentHash: result.payment_hash };
  }

  /**
   * NIP-47's pay_invoice has no client-specified fee budget parameter — the
   * wallet applies its own routing-fee policy (ADR-019 §5). `maxFeeMsat` is
   * accepted for interface parity with the other adapters but has no effect
   * here; that gap is documented, not silently swallowed.
   */
  async payInvoice(bolt11: string, _maxFeeMsat: bigint): Promise<{ paymentHash: Hex }> {
    await this.call<{ preimage?: string }>(
      'pay_invoice',
      { invoice: bolt11 },
      this.opts.payInvoiceTimeoutMs ?? DEFAULT_PAY_INVOICE_TIMEOUT_MS,
    );
    return { paymentHash: extractPaymentHash(bolt11) };
  }

  async settleHoldInvoice(preimage: Hex): Promise<void> {
    await this.call('settle_hold_invoice', { preimage });
  }

  async cancelHoldInvoice(hash: Hex): Promise<void> {
    await this.call('cancel_hold_invoice', { payment_hash: hash });
  }

  async lookupInvoice(hash: Hex): Promise<InvoiceState> {
    const result = await this.call<{ state?: string; expires_at?: number }>('lookup_invoice', {
      payment_hash: hash,
    });
    return mapInvoiceState(result);
  }

  /** get_info — used by probeNwcWallet (connect-time capability check) and
   *  available directly for callers who want a live re-probe. */
  async getInfo(): Promise<{ methods: string[]; notifications: string[] }> {
    const result = await this.call<{ methods?: string[]; notifications?: string[] }>(
      'get_info',
      {},
    );
    return { methods: result.methods ?? [], notifications: result.notifications ?? [] };
  }

  // -------------------------------------------------------------------------

  private async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const encryption = this.opts.encryption;
    const content = JSON.stringify({ method, params });
    const encryptedContent =
      encryption === 'nip44_v2'
        ? nip44Encrypt(this.params.clientSecretKey, this.params.walletPubkey, content)
        : nip04Encrypt(this.params.clientSecretKey, this.params.walletPubkey, content);

    const unsigned: UnsignedNostrEvent = {
      pubkey: this.clientPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: REQUEST_KIND,
      tags: [
        ['p', this.params.walletPubkey],
        ['encryption', encryption],
      ],
      content: encryptedContent,
    };
    const requestEvent = signEvent(unsigned, this.params.clientSecretKey);

    const replyFilter: NostrFilter = {
      kinds: [RESPONSE_KIND],
      authors: [this.params.walletPubkey],
      '#e': [requestEvent.id],
    };

    const transportFactory =
      this.opts.transportFactory ?? ((relays) => new WebSocketNwcTransport(relays));
    const transport = transportFactory(this.params.relays);
    const effectiveTimeout = timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let reply: NostrEvent;
    try {
      reply = await transport.request(requestEvent, replyFilter, effectiveTimeout);
    } catch (err) {
      if (err instanceof NwcTimeoutError) {
        throw new NwcRpcError('TIMEOUT', `${method}: no reply within ${effectiveTimeout}ms`);
      }
      if (err instanceof NwcRelayError) {
        throw new NwcRpcError('OTHER', `${method}: ${err.message}`);
      }
      throw err;
    }

    const decrypted =
      encryption === 'nip44_v2'
        ? nip44Decrypt(this.params.clientSecretKey, this.params.walletPubkey, reply.content)
        : nip04Decrypt(this.params.clientSecretKey, this.params.walletPubkey, reply.content);

    let parsed: NwcRpcReply<T>;
    try {
      parsed = JSON.parse(decrypted) as NwcRpcReply<T>;
    } catch {
      throw new NwcRpcError('OTHER', `${method}: reply was not valid JSON`);
    }
    if (parsed.error) throw new NwcRpcError(parsed.error.code, parsed.error.message);
    if (parsed.result === null || parsed.result === undefined) {
      throw new NwcRpcError('OTHER', `${method}: reply had neither result nor error`);
    }
    return parsed.result;
  }
}

function msatToNumber(amountMsat: bigint): number {
  if (amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`nwc: amountMsat ${amountMsat} exceeds what NWC's JSON amount can carry`);
  }
  return Number(amountMsat);
}

/**
 * ADR-019 §6: the base NIP-47 spec's `state` enum for invoices is only
 * loosely documented once hold invoices enter the picture. We recognize the
 * values the ecosystem is known to use (pending/accepted/settled and both
 * cancelled spellings) and, mirroring the LND REST adapter's own
 * cancelled-vs-expired disambiguation (ADR-013), fall back to comparing
 * `expires_at` against the clock for anything else rather than guess.
 */
function mapInvoiceState(result: { state?: string; expires_at?: number }): InvoiceState {
  switch (result.state) {
    case 'settled':
      return 'settled';
    case 'accepted':
      return 'held';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    // Real-interop finding (ADR-019 §7, verified against Alby Hub on
    // regtest): a cancelled hold invoice comes back as the spec's terminal
    // "failed", not "cancelled". We only ever look up invoices on the wallet
    // that ISSUED them (the coordinator asks the payee — ADR-013), so a
    // failed incoming invoice that has not yet expired can only mean the
    // hold was cancelled. Past expiry the wallet reports "expired" anyway.
    case 'failed':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default: {
      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof result.expires_at === 'number' && nowSec >= result.expires_at) return 'expired';
      return 'open';
    }
  }
}

// ---------------------------------------------------------------------------
// Connect-time capability probe (used by apps/api's /me/wallet route).

const BASELINE_METHODS = ['pay_invoice', 'make_invoice', 'lookup_invoice'];
const HOLD_METHODS = ['make_hold_invoice', 'settle_hold_invoice', 'cancel_hold_invoice'];

export interface NwcCapabilities {
  encryption: NwcEncryption;
  methods: string[];
  /** All of pay_invoice/make_invoice/lookup_invoice — the minimum for ANY
   *  Mercurio role to use this wallet at all. */
  baseline: boolean;
  /** All of make_hold_invoice/settle_hold_invoice/cancel_hold_invoice — the
   *  minimum for a money-bearing role (ADR-019 §4). */
  holdInvoice: boolean;
}

export class NwcProbeError extends Error {}

// Shorter than DEFAULT_TIMEOUT_MS: this probe runs synchronously inside a
// user-facing HTTP request (POST /me/wallet), not a background worker call —
// worst case (both encryption schemes fail) the caller waits ~2x this.
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Connects, negotiates encryption (NIP-44 preferred, NIP-04 fallback — ADR-019
 * §3) and calls get_info to learn what the wallet actually supports. Throws
 * NwcUriError for a malformed connection string, NwcProbeError if neither
 * encryption scheme gets a reply (unreachable relay, wallet down, etc).
 */
export async function probeNwcWallet(
  uri: string,
  opts: { transportFactory?: (relays: string[]) => NwcTransport; timeoutMs?: number } = {},
): Promise<NwcCapabilities> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const params = parseNwcUri(uri);
  let lastError: unknown;
  for (const encryption of ['nip44_v2', 'nip04'] as const) {
    try {
      const wallet = new NwcWallet(params, {
        encryption,
        ...(opts.transportFactory && { transportFactory: opts.transportFactory }),
        timeoutMs,
      });
      const { methods } = await wallet.getInfo();
      return {
        encryption,
        methods,
        baseline: BASELINE_METHODS.every((m) => methods.includes(m)),
        holdInvoice: HOLD_METHODS.every((m) => methods.includes(m)),
      };
    } catch (err) {
      lastError = err;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new NwcProbeError(`nwc: get_info failed with both nip44 and nip04 (${reason})`);
}
