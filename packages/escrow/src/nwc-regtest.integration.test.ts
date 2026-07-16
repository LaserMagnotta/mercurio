// Integration suite: the NWC adapter against a REAL nostr relay and REAL
// Alby Hub wallet services fronting the regtest LND nodes (ADR-019 §7 — the
// same lifecycle nwc.test.ts proves on the in-process fake, now end to end:
// NIP-44 encryption, NIP-47 hold-invoice extension, HTLCs actually held,
// funds actually moving). Prerequisites:
//
//   docker compose -f infra/docker/docker-compose.yml up -d
//   ./infra/docker/bootstrap.sh
//   pnpm test:integration
//
// alice = sender/payer (albyhub-alice), bob = carrier/payee (albyhub-bob).
// carol keeps using the lnd_rest adapter and plays no part here. Channel
// balances are asserted over raw LND REST — the wallet service must not be
// the one grading its own homework.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conditionalPayments,
  findOrCreateAccount,
  getAccountBalance,
  journalEntries,
} from '@mercurio/db';
import { NwcWallet, parseNwcUri, probeNwcWallet, type NwcCapabilities } from './adapters/nwc';
import { PreimageCoordinator } from './coordinator';
import type { CoordinatorEvent } from './types';
import { VOLUMES, localBalanceMsat, preflightNode, waitFor } from './testing/regtest';
import { createEscrowWorld, type EscrowWorld } from './testing/world';

const AMOUNT = 100_000n; // msat = 100 sat
const RELAY_URL = process.env.NWC_RELAY ?? 'ws://127.0.0.1:7447';

type UserName = 'alice' | 'bob';

/** bootstrap.sh stores each pairing URI exactly as Alby Hub minted it, so
 *  its relay= points at the compose-internal address (ws://nostr-relay:8080).
 *  The hubs live inside that network; this test does not — swap in the
 *  host-mapped port of the very same relay. */
function readNwcUri(name: UserName): string {
  const path = `${VOLUMES}nwc/${name}.nwc`;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(
      `missing NWC connection string ${path}. Provision the NWC wallet services first:\n` +
        '  docker compose -f infra/docker/docker-compose.yml up -d\n' +
        '  ./infra/docker/bootstrap.sh',
    );
  }
  const url = new URL(raw);
  url.searchParams.set('relay', RELAY_URL);
  return url.toString();
}

async function probeOrExplain(name: UserName, uri: string): Promise<NwcCapabilities> {
  try {
    return await probeNwcWallet(uri);
  } catch (err) {
    throw new Error(
      `NWC probe failed for ${name} (${err}).\n` +
        'With the stack up, suspect the relay/network first, encryption second — a wrong\n' +
        'scheme surfaces as a silent timeout, not an error (ADR-019 §3). Re-provision with\n' +
        '  ./infra/docker/bootstrap.sh',
    );
  }
}

describe('NWC adapter against a real relay and Alby Hub wallet services (regtest)', () => {
  let caps: Record<UserName, NwcCapabilities>;
  let wallets: Record<UserName, NwcWallet>;
  let world: EscrowWorld;
  let coordinator: PreimageCoordinator;

  beforeAll(async () => {
    // The hubs are only as healthy as the LND nodes under them.
    await preflightNode('alice');
    await preflightNode('bob');

    const uris = { alice: readNwcUri('alice'), bob: readNwcUri('bob') };
    caps = {
      alice: await probeOrExplain('alice', uris.alice),
      bob: await probeOrExplain('bob', uris.bob),
    };
    wallets = {
      // Paying a HOLD invoice over NWC gets no reply until settle/cancel
      // (ADR-019 §5): don't sit out the full 90 s default — the coordinator
      // treats a dispatch failure as non-fatal and pollOnce observes the
      // truth from the payee, so a short bounded wait loses nothing.
      alice: new NwcWallet(parseNwcUri(uris.alice), {
        encryption: caps.alice.encryption,
        payInvoiceTimeoutMs: 5_000,
      }),
      bob: new NwcWallet(parseNwcUri(uris.bob), { encryption: caps.bob.encryption }),
    };
  });

  beforeEach(async () => {
    world = await createEscrowWorld(); // fresh pglite per test: ledger assertions stay local
    const userToWallet = new Map<string, UserName>([
      [world.senderId, 'alice'],
      [world.carrierId, 'bob'],
    ]);
    coordinator = new PreimageCoordinator({
      db: world.db,
      resolveWallet: async (userId) => {
        const name = userToWallet.get(userId);
        if (!name) throw new Error(`no NWC wallet mapping for user ${userId}`);
        return wallets[name];
      },
      coordinatorKey: randomBytes(32),
    });
  });

  function createParams(
    overrides: Partial<Parameters<PreimageCoordinator['createConditionalPayment']>[0]> = {},
  ) {
    return {
      shipmentId: world.shipmentId,
      payerId: world.senderId, // alice
      payeeId: world.carrierId, // bob
      amountMsat: AMOUNT,
      purpose: 'leg_payment' as const,
      ref: { type: 'leg' as const, id: crypto.randomUUID() },
      holdWindowSeconds: 3600,
      idem: crypto.randomUUID(),
      ...overrides,
    };
  }

  async function waitForState(id: string, state: string): Promise<CoordinatorEvent[]> {
    const all: CoordinatorEvent[] = [];
    await waitFor(`payment ${id} -> ${state}`, async () => {
      all.push(...(await coordinator.pollOnce()));
      const [row] = await world.db
        .select()
        .from(conditionalPayments)
        .where(eq(conditionalPayments.id, id));
      return row?.state === state ? row : undefined;
    });
    return all;
  }

  async function commitmentBalance(): Promise<bigint> {
    const account = await findOrCreateAccount(world.db, {
      ownerType: 'shipment',
      ownerId: world.shipmentId,
      kind: 'commitment',
    });
    return getAccountBalance(world.db, account);
  }

  it('probe: negotiates NIP-44 and reports real hold-invoice capability', () => {
    for (const name of ['alice', 'bob'] as const) {
      expect(caps[name].baseline).toBe(true);
      expect(caps[name].holdInvoice).toBe(true);
      // NIP-44 v2 must have won the negotiation against a modern wallet
      // service: falling back to NIP-04 here would mean our NIP-44
      // implementation does not interoperate for real.
      expect(caps[name].encryption).toBe('nip44_v2');
    }
  });

  it('a paid hold becomes held: funds in flight, commitment on the ledger', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    const events = await waitForState(id, 'held');

    expect(events.some((e) => e.type === 'payment_held' && e.paymentId === id)).toBe(true);
    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(await wallets.bob.lookupInvoice(row!.paymentHash)).toBe('held');
    expect(await commitmentBalance()).toBe(AMOUNT);
  });

  it('release: the payee actually collects, straight from the payer', async () => {
    const bobBefore = await localBalanceMsat('bob');

    const id = await coordinator.createConditionalPayment(createParams());
    await waitForState(id, 'held');
    await coordinator.release(id, 'release-nwc-itest');

    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(row!.state).toBe('settled');
    await waitFor('bob invoice settled', async () =>
      (await wallets.bob.lookupInvoice(row!.paymentHash)) === 'settled' ? true : undefined,
    );
    // Real money on bob's side of the channel (direct hop: no routing fee).
    await waitFor('bob channel balance credited', async () => {
      const delta = (await localBalanceMsat('bob')) - bobBefore;
      return delta === AMOUNT ? true : undefined;
    });
    expect(await commitmentBalance()).toBe(0n); // held then settled: nets out
  });

  it('refund: the payer gets their funds back, untouched', async () => {
    const aliceBefore = await localBalanceMsat('alice');

    const id = await coordinator.createConditionalPayment(createParams());
    await waitForState(id, 'held');
    // The hold really bites: alice's spendable channel balance dropped.
    expect(await localBalanceMsat('alice')).toBeLessThan(aliceBefore);

    await coordinator.refund(id, 'refund-nwc-itest');

    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(row!.state).toBe('cancelled');
    // Interop finding baked into the adapter (ADR-019 §5): Alby Hub reports
    // a cancelled hold as "failed"; mapInvoiceState must read it as
    // cancelled, not fall back to 'open'.
    expect(await wallets.bob.lookupInvoice(row!.paymentHash)).toBe('cancelled');
    await waitFor('alice channel balance restored', async () =>
      (await localBalanceMsat('alice')) === aliceBefore ? true : undefined,
    );
    expect(await commitmentBalance()).toBe(0n);
  });

  it('an unpayable hold expires: no funds ever committed', async () => {
    // 20M sat >> the 5M sat channel: alice's payment dispatch fails, the
    // invoice can never be paid and dies by expiry.
    const id = await coordinator.createConditionalPayment(
      createParams({ amountMsat: 20_000_000_000n, holdWindowSeconds: 10 }),
    );
    const events = await waitForState(id, 'expired');

    expect(events.some((e) => e.type === 'payment_expired' && e.paymentId === id)).toBe(true);
    expect(await world.db.select().from(journalEntries)).toHaveLength(0);
  });
});
