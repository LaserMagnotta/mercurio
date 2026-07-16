import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePreimage } from '../crypto';
import { getPublicKeyHex } from '../nostr/event';
import {
  FakeNwcWalletService,
  InMemoryNwcTransport,
  InMemoryRelay,
} from '../testing/nwc-fake-relay';
import { FakeLightningNetwork } from './fake';
import {
  NwcProbeError,
  NwcRpcError,
  NwcUriError,
  NwcWallet,
  parseNwcUri,
  probeNwcWallet,
  type NwcEncryption,
} from './nwc';

function freshSecretHex(): string {
  return randomBytes(32).toString('hex');
}

/** Awaits `promise`, expecting it to reject, and returns the rejection
 *  reason — a `.catch((e) => e as T)` would type the resolved value too. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

/** Random bytes aren't a valid secp256k1 x-only pubkey ~half the time
 *  (the x-coordinate must be on the curve); derive one from a real keypair
 *  wherever a test actually exercises ECDH (nip04/nip44), not just parsing. */
function randomWalletPubkey(): string {
  return getPublicKeyHex(freshSecretHex());
}

function buildUri(
  walletPubkey: string,
  clientSecretHex: string,
  relay = 'ws://fake-relay',
): string {
  return `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(relay)}&secret=${clientSecretHex}`;
}

describe('parseNwcUri', () => {
  it('parses a well-formed connection string', () => {
    const walletPubkey = randomBytes(32).toString('hex');
    const secret = freshSecretHex();
    const params = parseNwcUri(buildUri(walletPubkey, secret));
    expect(params.walletPubkey).toBe(walletPubkey);
    expect(params.relays).toEqual(['ws://fake-relay']);
    expect(params.clientSecretKey).toBe(secret);
  });

  it('accepts multiple relay= params in order', () => {
    const walletPubkey = randomBytes(32).toString('hex');
    const uri =
      `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://a')}` +
      `&relay=${encodeURIComponent('wss://b')}&secret=${freshSecretHex()}`;
    expect(parseNwcUri(uri).relays).toEqual(['wss://a', 'wss://b']);
  });

  it('carries an optional lud16', () => {
    const walletPubkey = randomBytes(32).toString('hex');
    const uri = `${buildUri(walletPubkey, freshSecretHex())}&lud16=${encodeURIComponent('me@example.com')}`;
    expect(parseNwcUri(uri).lud16).toBe('me@example.com');
  });

  it('rejects a wrong scheme', () => {
    expect(() => parseNwcUri('https://example.com')).toThrow(NwcUriError);
  });

  it('rejects a non-hex or wrong-length pubkey', () => {
    expect(() => parseNwcUri(buildUri('not-hex', freshSecretHex()))).toThrow(NwcUriError);
  });

  it('rejects a missing relay', () => {
    const walletPubkey = randomBytes(32).toString('hex');
    expect(() =>
      parseNwcUri(`nostr+walletconnect://${walletPubkey}?secret=${freshSecretHex()}`),
    ).toThrow(NwcUriError);
  });

  it('rejects a non-ws(s) relay', () => {
    expect(() =>
      parseNwcUri(
        buildUri(randomBytes(32).toString('hex'), freshSecretHex(), 'https://not-a-relay'),
      ),
    ).toThrow(NwcUriError);
  });

  it('rejects a missing or malformed secret', () => {
    const walletPubkey = randomBytes(32).toString('hex');
    expect(() =>
      parseNwcUri(`nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://r')}`),
    ).toThrow(NwcUriError);
  });
});

/** One in-memory relay + FakeLightningNetwork shared by a payee and a payer
 *  NwcWallet, each backed by its own fake wallet service — the same shape as
 *  two real Mercurio users each with their own NWC-connected wallet. */
function twoPartyFixture(opts?: {
  supportsHoldInvoice?: boolean;
  acceptedEncryption?: NwcEncryption[];
  payerInitialBalanceMsat?: bigint;
}) {
  const relay = new InMemoryRelay();
  const network = new FakeLightningNetwork();

  network.wallet('payee', 0n);
  const payeeService = new FakeNwcWalletService({
    relay,
    network,
    walletId: 'payee',
    secretKey: freshSecretHex(),
    ...(opts?.supportsHoldInvoice !== undefined && {
      supportsHoldInvoice: opts.supportsHoldInvoice,
    }),
    ...(opts?.acceptedEncryption && { acceptedEncryption: opts.acceptedEncryption }),
  });

  network.wallet('payer', opts?.payerInitialBalanceMsat ?? 1_000_000n);
  const payerService = new FakeNwcWalletService({
    relay,
    network,
    walletId: 'payer',
    secretKey: freshSecretHex(),
  });

  const transportFactory = () => new InMemoryNwcTransport(relay);
  const encryption: NwcEncryption = opts?.acceptedEncryption?.[0] ?? 'nip44_v2';
  const payeeWallet = new NwcWallet(parseNwcUri(buildUri(payeeService.pubkey, freshSecretHex())), {
    encryption,
    transportFactory,
    timeoutMs: 1000,
  });
  const payerWallet = new NwcWallet(parseNwcUri(buildUri(payerService.pubkey, freshSecretHex())), {
    encryption: 'nip44_v2',
    transportFactory,
    timeoutMs: 1000,
  });

  return {
    relay,
    network,
    payeeService,
    payerService,
    payeeWallet,
    payerWallet,
    close: () => {
      payeeService.close();
      payerService.close();
    },
  };
}

describe('probeNwcWallet', () => {
  it('negotiates nip44 and reports full capabilities for a modern wallet', async () => {
    const relay = new InMemoryRelay();
    const service = new FakeNwcWalletService({
      relay,
      network: new FakeLightningNetwork(),
      walletId: 'w',
      secretKey: freshSecretHex(),
    });
    const uri = buildUri(service.pubkey, freshSecretHex());
    const caps = await probeNwcWallet(uri, {
      transportFactory: () => new InMemoryNwcTransport(relay),
      timeoutMs: 500,
    });
    expect(caps.encryption).toBe('nip44_v2');
    expect(caps.baseline).toBe(true);
    expect(caps.holdInvoice).toBe(true);
  });

  it('falls back to nip04 for a legacy wallet', async () => {
    const relay = new InMemoryRelay();
    const service = new FakeNwcWalletService({
      relay,
      network: new FakeLightningNetwork(),
      walletId: 'w',
      secretKey: freshSecretHex(),
      acceptedEncryption: ['nip04'],
    });
    const uri = buildUri(service.pubkey, freshSecretHex());
    const caps = await probeNwcWallet(uri, {
      transportFactory: () => new InMemoryNwcTransport(relay),
      timeoutMs: 500,
    });
    expect(caps.encryption).toBe('nip04');
    expect(caps.baseline).toBe(true);
  });

  it('reports holdInvoice = false for a wallet without the extension', async () => {
    const relay = new InMemoryRelay();
    const service = new FakeNwcWalletService({
      relay,
      network: new FakeLightningNetwork(),
      walletId: 'w',
      secretKey: freshSecretHex(),
      supportsHoldInvoice: false,
    });
    const uri = buildUri(service.pubkey, freshSecretHex());
    const caps = await probeNwcWallet(uri, {
      transportFactory: () => new InMemoryNwcTransport(relay),
      timeoutMs: 500,
    });
    expect(caps.baseline).toBe(true);
    expect(caps.holdInvoice).toBe(false);
  });

  it('throws NwcProbeError when nothing answers', async () => {
    const relay = new InMemoryRelay(); // no service subscribed
    const uri = buildUri(randomWalletPubkey(), freshSecretHex());
    await expect(
      probeNwcWallet(uri, {
        transportFactory: () => new InMemoryNwcTransport(relay),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(NwcProbeError);
  });
});

describe('NwcWallet hold-invoice lifecycle', () => {
  it('runs a full open -> held -> settled flow between two independent NWC wallets', async () => {
    const { network, payeeWallet, payerWallet, close } = twoPartyFixture();
    const { preimageHex, hashHex } = generatePreimage();

    const { bolt11 } = await payeeWallet.makeHoldInvoice(500_000n, hashHex, 3600, 'carrier bond');
    expect(await payeeWallet.lookupInvoice(hashHex)).toBe('open');

    const { paymentHash } = await payerWallet.payInvoice(bolt11, 0n);
    expect(paymentHash).toBe(hashHex);
    expect(await payeeWallet.lookupInvoice(hashHex)).toBe('held');
    expect(network.balanceOf('payer')).toBe(500_000n); // debited on hold, not before

    await payeeWallet.settleHoldInvoice(preimageHex);
    expect(await payeeWallet.lookupInvoice(hashHex)).toBe('settled');
    expect(network.balanceOf('payee')).toBe(500_000n);

    close();
  });

  it('cancels a hold and returns funds to the payer', async () => {
    const { network, payeeWallet, payerWallet, close } = twoPartyFixture();
    const { hashHex } = generatePreimage();

    const { bolt11 } = await payeeWallet.makeHoldInvoice(200_000n, hashHex, 3600, 'bond');
    await payerWallet.payInvoice(bolt11, 0n);
    expect(await payeeWallet.lookupInvoice(hashHex)).toBe('held');

    await payeeWallet.cancelHoldInvoice(hashHex);
    expect(await payeeWallet.lookupInvoice(hashHex)).toBe('cancelled');
    expect(network.balanceOf('payer')).toBe(1_000_000n); // refunded in full

    close();
  });

  it('round-trips a plain (non-hold) invoice, settling instantly', async () => {
    const { network, payeeWallet, payerWallet, close } = twoPartyFixture();
    const { bolt11, paymentHash } = await payeeWallet.makeInvoice(1_000n, 'hub fee');
    expect(paymentHash).toHaveLength(64);

    await payerWallet.payInvoice(bolt11, 0n);
    expect(await payeeWallet.lookupInvoice(paymentHash)).toBe('settled');
    expect(network.balanceOf('payee')).toBe(1_000n);

    close();
  });
});

describe('NwcWallet error handling', () => {
  it('surfaces NOT_IMPLEMENTED as a typed NwcRpcError', async () => {
    const { payeeWallet, close } = twoPartyFixture({ supportsHoldInvoice: false });
    const err = (await captureRejection(
      payeeWallet.makeHoldInvoice(1000n, randomBytes(32).toString('hex'), 3600, 'x'),
    )) as NwcRpcError;
    expect(err).toBeInstanceOf(NwcRpcError);
    expect(err.code).toBe('NOT_IMPLEMENTED');
    close();
  });

  it('times out as a typed NwcRpcError when nothing answers', async () => {
    const relay = new InMemoryRelay(); // no wallet service listening
    const wallet = new NwcWallet(parseNwcUri(buildUri(randomWalletPubkey(), freshSecretHex())), {
      encryption: 'nip44_v2',
      transportFactory: () => new InMemoryNwcTransport(relay),
      timeoutMs: 50,
    });
    const err = (await captureRejection(wallet.getInfo())) as NwcRpcError;
    expect(err).toBeInstanceOf(NwcRpcError);
    expect(err.code).toBe('TIMEOUT');
  });

  it('ignores a forged reply from an impersonator and still times out', async () => {
    const relay = new InMemoryRelay();
    relay.subscribe((evt) => {
      if (evt.kind !== 23194) return;
      // A garbage "reply" with an invalid signature, on the right kind/tags:
      // verifyEvent must reject it rather than let the client trust it.
      relay.publish({
        id: evt.id,
        pubkey: 'a'.repeat(64),
        created_at: evt.created_at,
        kind: 23195,
        tags: [
          ['p', evt.pubkey],
          ['e', evt.id],
        ],
        content: 'garbage',
        sig: '0'.repeat(128),
      });
    });
    const wallet = new NwcWallet(parseNwcUri(buildUri(randomWalletPubkey(), freshSecretHex())), {
      encryption: 'nip44_v2',
      transportFactory: () => new InMemoryNwcTransport(relay),
      timeoutMs: 100,
    });
    const err = (await captureRejection(wallet.getInfo())) as NwcRpcError;
    expect(err).toBeInstanceOf(NwcRpcError);
    expect(err.code).toBe('TIMEOUT');
  });
});
