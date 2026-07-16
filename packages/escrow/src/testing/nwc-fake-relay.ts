// In-process NWC relay + wallet service double (style: FakeLightningNetwork).
// No real network, no real WebSocket: an in-memory pub/sub bus stands in for
// the relay, and FakeNwcWalletService plays the wallet side of the NIP-47
// protocol for real — real event signing, real NIP-04/NIP-44 encryption,
// real bech32-shaped bolt11 strings — backed by the SAME FakeLightningNetwork
// engine the other adapter tests use. This exercises NwcWallet's entire
// protocol-handling code path; only the transport is swapped out.

import { getPublicKeyHex, signEvent, verifyEvent, type NostrEvent } from '../nostr/event';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04';
import { nip44Decrypt, nip44Encrypt } from '../nostr/nip44';
import { NwcTimeoutError, type NostrFilter, type NwcTransport } from '../nostr/relay';
import type { FakeLightningNetwork } from '../adapters/fake';
import { encodeFakeInvoiceForTests, extractPaymentHash } from '../adapters/bolt11';
import type { NwcEncryption } from '../adapters/nwc';

const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;

function matchesFilter(evt: NostrEvent, filter: NostrFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(evt.kind)) return false;
  if (filter.authors && !filter.authors.includes(evt.pubkey)) return false;
  const eTags = evt.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
  if (filter['#e'] && !filter['#e'].some((id) => eTags.includes(id))) return false;
  const pTags = evt.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
  if (filter['#p'] && !filter['#p'].some((pk) => pTags.includes(pk))) return false;
  return true;
}

/** A relay is just a pub/sub bus: every subscriber sees every publish. */
export class InMemoryRelay {
  private subscribers: Array<(evt: NostrEvent) => void> = [];

  publish(evt: NostrEvent): void {
    const snapshot = [...this.subscribers];
    queueMicrotask(() => {
      for (const fn of snapshot) fn(evt);
    });
  }

  subscribe(fn: (evt: NostrEvent) => void): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }
}

/** NwcTransport implementation over an InMemoryRelay — same request/reply
 *  contract as WebSocketNwcTransport, no sockets involved. */
export class InMemoryNwcTransport implements NwcTransport {
  constructor(private readonly relay: InMemoryRelay) {}

  request(event: NostrEvent, replyFilter: NostrFilter, timeoutMs: number): Promise<NostrEvent> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => {};

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new NwcTimeoutError(`fake relay: no reply within ${timeoutMs}ms`));
      }, timeoutMs);

      unsubscribe = this.relay.subscribe((evt) => {
        if (settled) return;
        if (!matchesFilter(evt, replyFilter) || !verifyEvent(evt)) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(evt);
      });

      this.relay.publish(event);
    });
  }
}

export interface FakeNwcWalletServiceOptions {
  relay: InMemoryRelay;
  network: FakeLightningNetwork;
  /** The FakeLightningNetwork wallet id this service is backed by. */
  walletId: string;
  /** This wallet SERVICE's own nostr identity (32-byte hex secret key). */
  secretKey: string;
  /** Default true: set false to simulate a wallet without the hold-invoice
   *  extension (ADR-019 §4 — capabilities.holdInvoice = false). */
  supportsHoldInvoice?: boolean;
  /** Which encryption tags this fake wallet will answer; others are dropped
   *  silently, exactly like a real wallet that can't decrypt them. Default:
   *  both (a modern, spec-compliant wallet). */
  acceptedEncryption?: NwcEncryption[];
  /** Overrides the get_info `methods` baseline — for simulating a wallet
   *  missing even pay_invoice/make_invoice/lookup_invoice. Default: all four
   *  base methods (a minimally-compliant wallet). */
  baseMethods?: string[];
}

const BASE_METHODS = ['pay_invoice', 'make_invoice', 'lookup_invoice', 'get_info'];
const HOLD_METHODS = ['make_hold_invoice', 'settle_hold_invoice', 'cancel_hold_invoice'];

/** Carries a NIP-47 machine error code, so dispatch() can report the exact
 *  code (e.g. NOT_IMPLEMENTED) instead of a generic OTHER. */
class NwcTestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class FakeNwcWalletService {
  readonly pubkey: string;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: FakeNwcWalletServiceOptions) {
    this.pubkey = getPublicKeyHex(opts.secretKey);
    this.unsubscribe = opts.relay.subscribe((evt) => {
      void this.handle(evt);
    });
  }

  close(): void {
    this.unsubscribe();
  }

  private acceptedEncryption(): NwcEncryption[] {
    return this.opts.acceptedEncryption ?? ['nip44_v2', 'nip04'];
  }

  private supportedMethods(): string[] {
    const base = this.opts.baseMethods ?? BASE_METHODS;
    return this.opts.supportsHoldInvoice === false ? base : [...base, ...HOLD_METHODS];
  }

  private async handle(evt: NostrEvent): Promise<void> {
    if (evt.kind !== REQUEST_KIND) return;
    if (!evt.tags.some(([k, v]) => k === 'p' && v === this.pubkey)) return;
    if (!verifyEvent(evt)) return;

    const encryption = (evt.tags.find(([k]) => k === 'encryption')?.[1] ??
      'nip04') as NwcEncryption;
    if (!this.acceptedEncryption().includes(encryption)) return; // silent drop, like a real wallet

    let requestJson: string;
    try {
      requestJson =
        encryption === 'nip44_v2'
          ? nip44Decrypt(this.opts.secretKey, evt.pubkey, evt.content)
          : nip04Decrypt(this.opts.secretKey, evt.pubkey, evt.content);
    } catch {
      return; // undecryptable request: a real wallet would also just drop it
    }

    const { method, params } = JSON.parse(requestJson) as {
      method: string;
      params: Record<string, unknown>;
    };
    const { errorCode, errorMessage, result } = await this.execute(method, params);
    const replyPayload =
      errorCode !== undefined
        ? { result_type: method, error: { code: errorCode, message: errorMessage }, result: null }
        : { result_type: method, error: null, result };
    const replyContent =
      encryption === 'nip44_v2'
        ? nip44Encrypt(this.opts.secretKey, evt.pubkey, JSON.stringify(replyPayload))
        : nip04Encrypt(this.opts.secretKey, evt.pubkey, JSON.stringify(replyPayload));

    const signed = signEvent(
      {
        pubkey: this.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: RESPONSE_KIND,
        tags: [
          ['p', evt.pubkey],
          ['e', evt.id],
        ],
        content: replyContent,
      },
      this.opts.secretKey,
    );
    this.opts.relay.publish(signed);
  }

  private async execute(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ errorCode?: string; errorMessage?: string; result: unknown }> {
    try {
      return { result: await this.dispatch(method, params) };
    } catch (err) {
      if (err instanceof NwcTestError) {
        return { errorCode: err.code, errorMessage: err.message, result: null };
      }
      return {
        errorCode: 'OTHER',
        errorMessage: err instanceof Error ? err.message : String(err),
        result: null,
      };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const wallet = this.opts.network.wallet(this.opts.walletId);
    switch (method) {
      case 'get_info':
        return { alias: 'fake-nwc-wallet', methods: this.supportedMethods(), notifications: [] };

      case 'make_hold_invoice': {
        if (this.opts.supportsHoldInvoice === false) {
          throw new NwcTestError('NOT_IMPLEMENTED', 'this fake wallet has no hold-invoice support');
        }
        const hash = String(params.payment_hash);
        await wallet.makeHoldInvoice(
          BigInt(params.amount as number),
          hash,
          Number(params.expiry),
          String(params.description ?? ''),
        );
        return { invoice: encodeFakeInvoiceForTests(hash), payment_hash: hash };
      }

      case 'make_invoice': {
        const { paymentHash } = await wallet.makeInvoice(
          BigInt(params.amount as number),
          String(params.description ?? ''),
        );
        return { invoice: encodeFakeInvoiceForTests(paymentHash), payment_hash: paymentHash };
      }

      case 'pay_invoice': {
        const hash = extractPaymentHash(String(params.invoice));
        await wallet.payInvoice(`fakelnbc:${hash}`, 0n);
        return { preimage: '', fees_paid: 0 };
      }

      case 'settle_hold_invoice':
        await wallet.settleHoldInvoice(String(params.preimage));
        return {};

      case 'cancel_hold_invoice':
        await wallet.cancelHoldInvoice(String(params.payment_hash));
        return {};

      case 'lookup_invoice': {
        const state = await wallet.lookupInvoice(String(params.payment_hash));
        return { state: toNwcState(state) };
      }

      default:
        throw new NwcTestError('NOT_IMPLEMENTED', `unknown method ${method}`);
    }
  }
}

function toNwcState(state: string): string {
  switch (state) {
    case 'open':
      return 'pending';
    case 'held':
      return 'accepted';
    default:
      return state; // settled/cancelled/expired already match
  }
}
