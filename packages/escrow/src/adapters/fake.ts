// In-memory Lightning "network" for unit tests (ADR-004: the fake adapter).
//
// It is deliberately NOT a mock that answers whatever the test wants: it
// models the actual hold-invoice mechanics — balances leave the payer when
// an HTLC is accepted, reach the payee only on settle, come back on cancel,
// and settling REQUIRES the exact preimage of the invoice hash. A
// coordinator bug (wrong preimage, settle before hold, pay after expiry)
// fails here the same way it would fail on a real node.

import { createHash, randomBytes } from 'node:crypto';
import type { Hex, InvoiceState, WalletConnection } from '../types.js';

interface FakeInvoice {
  payeeId: string;
  amountMsat: bigint;
  hashHex: string;
  hold: boolean;
  state: InvoiceState;
  expiresAtMs: number;
  /** Set when an HTLC is accepted (hold) or the invoice is settled. */
  payerId?: string;
  /** Set on settle: the revealed preimage, as a real node would record it. */
  preimageHex?: string;
  /** For non-hold invoices the payee's wallet knows the preimage itself. */
  internalPreimageHex?: string;
}

const BOLT11_PREFIX = 'fakelnbc:';

export class FakeLightningNetwork {
  private readonly invoices = new Map<string, FakeInvoice>();
  private readonly balances = new Map<string, bigint>();

  /** Injectable clock so tests can drive invoice expiry deterministically. */
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  wallet(walletId: string, initialBalanceMsat = 0n): FakeWalletConnection {
    if (!this.balances.has(walletId)) this.balances.set(walletId, initialBalanceMsat);
    return new FakeWalletConnection(this, walletId);
  }

  balanceOf(walletId: string): bigint {
    return this.balances.get(walletId) ?? 0n;
  }

  invoiceState(hashHex: string): InvoiceState {
    const invoice = this.mustGet(hashHex);
    if (invoice.state === 'open' && this.nowMs() >= invoice.expiresAtMs) return 'expired';
    return invoice.state;
  }

  // ---- operations used by FakeWalletConnection ----------------------------

  addInvoice(params: {
    payeeId: string;
    amountMsat: bigint;
    hashHex: string;
    hold: boolean;
    expirySeconds: number;
    internalPreimageHex?: string;
  }): { bolt11: string } {
    if (this.invoices.has(params.hashHex)) {
      throw new Error(`fake: invoice with hash ${params.hashHex} already exists`);
    }
    this.invoices.set(params.hashHex, {
      payeeId: params.payeeId,
      amountMsat: params.amountMsat,
      hashHex: params.hashHex,
      hold: params.hold,
      state: 'open',
      expiresAtMs: this.nowMs() + params.expirySeconds * 1000,
      ...(params.internalPreimageHex !== undefined && {
        internalPreimageHex: params.internalPreimageHex,
      }),
    });
    return { bolt11: `${BOLT11_PREFIX}${params.hashHex}` };
  }

  pay(payerId: string, bolt11: string): { paymentHash: Hex } {
    if (!bolt11.startsWith(BOLT11_PREFIX)) throw new Error('fake: not a fake bolt11');
    const hashHex = bolt11.slice(BOLT11_PREFIX.length);
    const invoice = this.mustGet(hashHex);
    if (this.invoiceState(hashHex) !== 'open') {
      throw new Error(`fake: invoice ${hashHex} is ${this.invoiceState(hashHex)}, cannot pay`);
    }
    if (invoice.payeeId === payerId) throw new Error('fake: self-payment');
    const balance = this.balanceOf(payerId);
    if (balance < invoice.amountMsat) {
      throw new Error(`fake: insufficient balance (${balance} < ${invoice.amountMsat})`);
    }
    // Funds leave the payer the moment the HTLC is accepted — exactly the
    // "in-flight, committed to the fixed payee" semantics of a hold invoice.
    this.balances.set(payerId, balance - invoice.amountMsat);
    invoice.payerId = payerId;
    if (invoice.hold) {
      invoice.state = 'held';
    } else {
      invoice.state = 'settled';
      invoice.preimageHex = invoice.internalPreimageHex ?? '';
      this.credit(invoice.payeeId, invoice.amountMsat);
    }
    return { paymentHash: hashHex };
  }

  settleHold(walletId: string, preimageHex: Hex): void {
    // A real node derives the hash from the preimage — so do we. Settling
    // with anything but the true preimage is impossible by construction.
    const hashHex = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    const invoice = this.mustGet(hashHex);
    if (invoice.payeeId !== walletId) throw new Error('fake: not the invoice issuer');
    if (invoice.state === 'settled') return; // idempotent, like LND
    if (invoice.state !== 'held') {
      throw new Error(`fake: cannot settle invoice in state ${invoice.state}`);
    }
    invoice.state = 'settled';
    invoice.preimageHex = preimageHex;
    this.credit(invoice.payeeId, invoice.amountMsat);
  }

  cancelHold(walletId: string, hashHex: Hex): void {
    const invoice = this.mustGet(hashHex);
    if (invoice.payeeId !== walletId) throw new Error('fake: not the invoice issuer');
    if (invoice.state === 'cancelled' || invoice.state === 'expired') return; // idempotent
    if (invoice.state === 'settled') throw new Error('fake: cannot cancel a settled invoice');
    if (invoice.state === 'held' && invoice.payerId) {
      // The in-flight HTLC is released: funds return to the payer, untouched.
      this.credit(invoice.payerId, invoice.amountMsat);
    }
    invoice.state = 'cancelled';
  }

  private credit(walletId: string, amountMsat: bigint): void {
    this.balances.set(walletId, this.balanceOf(walletId) + amountMsat);
  }

  private mustGet(hashHex: string): FakeInvoice {
    const invoice = this.invoices.get(hashHex);
    if (!invoice) throw new Error(`fake: unknown invoice ${hashHex}`);
    return invoice;
  }
}

export class FakeWalletConnection implements WalletConnection {
  constructor(
    private readonly network: FakeLightningNetwork,
    readonly walletId: string,
  ) {}

  async makeHoldInvoice(
    amountMsat: bigint,
    hash: Hex,
    expirySeconds: number,
    _memo: string,
  ): Promise<{ bolt11: string }> {
    return this.network.addInvoice({
      payeeId: this.walletId,
      amountMsat,
      hashHex: hash,
      hold: true,
      expirySeconds,
    });
  }

  async makeInvoice(amountMsat: bigint, _memo: string): Promise<{ bolt11: string; paymentHash: Hex }> {
    const preimage = randomBytes(32);
    const hashHex = createHash('sha256').update(preimage).digest('hex');
    const { bolt11 } = this.network.addInvoice({
      payeeId: this.walletId,
      amountMsat,
      hashHex,
      hold: false,
      expirySeconds: 3600,
      internalPreimageHex: preimage.toString('hex'),
    });
    return { bolt11, paymentHash: hashHex };
  }

  async payInvoice(bolt11: string, _maxFeeMsat: bigint): Promise<{ paymentHash: Hex }> {
    return this.network.pay(this.walletId, bolt11);
  }

  async settleHoldInvoice(preimage: Hex): Promise<void> {
    this.network.settleHold(this.walletId, preimage);
  }

  async cancelHoldInvoice(hash: Hex): Promise<void> {
    this.network.cancelHold(this.walletId, hash);
  }

  async lookupInvoice(hash: Hex): Promise<InvoiceState> {
    return this.network.invoiceState(hash);
  }
}
