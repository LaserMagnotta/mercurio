// WalletConnection adapter for a user's own LND node over its REST proxy
// (ADR-004). In dev/regtest these are the lnd-alice/bob/carol containers;
// the same adapter works against any reachable LND with an invoice+router
// macaroon. Hold invoices via invoicesrpc (/v2/invoices/*), payments via
// routerrpc (/v2/router/send).
//
// LND REST speaks JSON with base64-encoded byte fields; hashes/preimages in
// Mercurio are lowercase hex, converted at this boundary only.

import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { Hex, InvoiceState, WalletConnection } from '../types';

export interface LndRestOptions {
  /** e.g. https://127.0.0.1:8081 */
  baseUrl: string;
  /** admin (or invoices+router) macaroon, hex encoded. */
  macaroonHex: string;
  /** Node TLS cert to trust (regtest nodes are self-signed). */
  tlsCert?: Buffer;
  /** Skip TLS verification entirely — regtest/dev ONLY. */
  allowInsecure?: boolean;
  /** Injectable clock for the open-vs-expired judgement in lookupInvoice. */
  now?: () => number;
}

interface LndInvoice {
  state?: 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED';
  creation_date?: string; // unix seconds, stringified int64
  expiry?: string; // seconds, stringified int64
}

interface LndPaymentUpdate {
  status?: 'UNKNOWN' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED';
  payment_hash?: string; // hex in routerrpc
  failure_reason?: string;
}

export class LndRestError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'LndRestError';
  }
}

export class LndRestWallet implements WalletConnection {
  private readonly now: () => number;

  constructor(private readonly opts: LndRestOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async makeHoldInvoice(
    amountMsat: bigint,
    hash: Hex,
    expirySeconds: number,
    memo: string,
  ): Promise<{ bolt11: string }> {
    const res = (await this.json('POST', '/v2/invoices/hodl', {
      hash: hexToBase64(hash),
      value_msat: amountMsat.toString(),
      expiry: String(expirySeconds),
      memo,
    })) as { payment_request?: string };
    if (!res.payment_request) throw new LndRestError('hodl invoice: no payment_request in reply');
    return { bolt11: res.payment_request };
  }

  async makeInvoice(amountMsat: bigint, memo: string): Promise<{ bolt11: string; paymentHash: Hex }> {
    const res = (await this.json('POST', '/v1/invoices', {
      value_msat: amountMsat.toString(),
      memo,
    })) as { payment_request?: string; r_hash?: string };
    if (!res.payment_request) throw new LndRestError('invoice: no payment_request in reply');
    if (!res.r_hash) throw new LndRestError('invoice: no r_hash in reply');
    return { bolt11: res.payment_request, paymentHash: base64ToHex(res.r_hash) };
  }

  /**
   * Dispatches via routerrpc and resolves on the FIRST stream update: a hold
   * payment stays IN_FLIGHT until the coordinator reveals or cancels, so
   * waiting for a terminal status here would deadlock the whole flow.
   * Closing the HTTP stream does not cancel the payment — LND keeps the
   * HTLC in flight, which is exactly the hold semantics we want.
   */
  async payInvoice(bolt11: string, maxFeeMsat: bigint): Promise<{ paymentHash: Hex }> {
    const update = (await this.streamFirst('POST', '/v2/router/send', {
      payment_request: bolt11,
      timeout_seconds: 60,
      fee_limit_msat: maxFeeMsat.toString(),
    })) as LndPaymentUpdate;
    if (update.status === 'FAILED') {
      throw new LndRestError(`payment failed: ${update.failure_reason ?? 'unknown reason'}`);
    }
    if (!update.payment_hash) throw new LndRestError('router send: no payment_hash in update');
    return { paymentHash: update.payment_hash };
  }

  async settleHoldInvoice(preimage: Hex): Promise<void> {
    try {
      await this.json('POST', '/v2/invoices/settle', { preimage: hexToBase64(preimage) });
    } catch (err) {
      if (isAlready(err, /already settled/i)) return; // idempotent, matches the fake
      throw err;
    }
  }

  async cancelHoldInvoice(hash: Hex): Promise<void> {
    try {
      await this.json('POST', '/v2/invoices/cancel', { payment_hash: hexToBase64(hash) });
    } catch (err) {
      if (isAlready(err, /already canceled|already cancelled/i)) return;
      throw err;
    }
  }

  async lookupInvoice(hash: Hex): Promise<InvoiceState> {
    // v1 lookup takes the hash as plain hex in the path and covers hold
    // invoices too — no need for the base64url gymnastics of /v2/lookup.
    const invoice = (await this.json('GET', `/v1/invoice/${hash}`)) as LndInvoice;
    const expired = this.pastExpiry(invoice);
    switch (invoice.state) {
      case 'ACCEPTED':
        return 'held';
      case 'SETTLED':
        return 'settled';
      case 'CANCELED':
        // LND has no EXPIRED state: its expiry watcher CANCELs unpaid
        // invoices. Distinguish by the invoice's own expiry clock.
        return expired ? 'expired' : 'cancelled';
      case 'OPEN':
      default:
        return expired ? 'expired' : 'open';
    }
  }

  // -------------------------------------------------------------------------

  private requestOptions(method: string, path: string): RequestOptions {
    const url = new URL(this.opts.baseUrl);
    return {
      method,
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path,
      headers: {
        'Grpc-Metadata-macaroon': this.opts.macaroonHex,
        'Content-Type': 'application/json',
      },
      ...(this.opts.tlsCert ? { ca: this.opts.tlsCert } : {}),
      ...(this.opts.allowInsecure ? { rejectUnauthorized: false } : {}),
    };
  }

  /** Buffered request; parses the body and throws LND's error message. */
  private json(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(this.requestOptions(method, path), (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          const parsed = tryParse(data);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed ?? {});
          } else {
            reject(new LndRestError(lndErrorMessage(parsed, data), res.statusCode));
          }
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** Server-streaming request; resolves with the first JSON line's `result`
   *  (or rejects on the first `error`), then drops the connection. */
  private streamFirst(method: string, path: string, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(this.requestOptions(method, path), (res) => {
        let buffer = '';
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          fn();
          res.destroy(); // detach; the payment lives on inside LND
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          const line = buffer.slice(0, newline).trim();
          if (!line) return;
          const parsed = tryParse(line) as { result?: unknown; error?: unknown } | undefined;
          if (parsed && 'error' in parsed && parsed.error) {
            finish(() => reject(new LndRestError(lndErrorMessage(parsed.error, line))));
          } else if (parsed && parsed.result !== undefined) {
            finish(() => resolve(parsed.result));
          } else {
            finish(() => reject(new LndRestError(`unexpected stream line: ${line}`)));
          }
        });
        res.on('end', () =>
          finish(() =>
            reject(
              new LndRestError(
                res.statusCode && res.statusCode >= 400
                  ? lndErrorMessage(tryParse(buffer), buffer)
                  : 'stream ended without a payment update',
                res.statusCode,
              ),
            ),
          ),
        );
      });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  private pastExpiry(invoice: LndInvoice): boolean {
    const creation = Number(invoice.creation_date ?? '0');
    const expiry = Number(invoice.expiry ?? '0');
    if (creation === 0) return false;
    return this.now() >= (creation + expiry) * 1000;
  }
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex');
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lndErrorMessage(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { message?: string; error?: string };
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
  }
  return raw.slice(0, 500) || 'empty error reply';
}

function isAlready(err: unknown, pattern: RegExp): boolean {
  return err instanceof LndRestError && pattern.test(err.message);
}
