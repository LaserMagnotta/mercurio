import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { findOrCreateAccount, getAccountBalance, postJournalEntry } from './ledger';
import { users } from './schema/index';

describe('ledger (double-entry, ADR-010)', () => {
  it('posts a balanced journal entry and updates balances (no cached balance: read via SUM)', async () => {
    const db = await createTestDb();
    const [alice] = await db.insert(users).values({ email: 'alice@example.com' }).returning();
    const [bob] = await db.insert(users).values({ email: 'bob@example.com' }).returning();
    if (!alice || !bob) throw new Error('setup failed');

    const aliceAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: alice.id,
      kind: 'external_wallet',
    });
    const bobAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: bob.id,
      kind: 'external_wallet',
    });

    await postJournalEntry(db, {
      eventType: 'leg_checkin',
      refType: 'leg',
      refId: crypto.randomUUID(),
      idempotencyKey: 'test-1',
      postings: [
        { accountId: aliceAccount, amountMsat: -1000n },
        { accountId: bobAccount, amountMsat: 1000n },
      ],
    });

    expect(await getAccountBalance(db, aliceAccount)).toBe(-1000n);
    expect(await getAccountBalance(db, bobAccount)).toBe(1000n);
  });

  it('rejects unbalanced postings before touching the database', async () => {
    const db = await createTestDb();
    const [alice] = await db.insert(users).values({ email: 'alice2@example.com' }).returning();
    if (!alice) throw new Error('setup failed');
    const account = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: alice.id,
      kind: 'external_wallet',
    });

    await expect(
      postJournalEntry(db, {
        eventType: 'leg_checkin',
        refType: 'leg',
        refId: crypto.randomUUID(),
        idempotencyKey: 'test-2',
        postings: [{ accountId: account, amountMsat: 500n }], // single posting: never balances
      }),
    ).rejects.toThrow(/at least two postings/);
  });

  it('the database itself rejects an unbalanced journal entry (defense in depth)', async () => {
    // Bypasses the application-level check to prove the DB trigger
    // (0001_ledger_invariants.sql) is the real invariant, not just the TS code.
    const db = await createTestDb();
    const [alice] = await db.insert(users).values({ email: 'alice3@example.com' }).returning();
    const [bob] = await db.insert(users).values({ email: 'bob3@example.com' }).returning();
    if (!alice || !bob) throw new Error('setup failed');
    const aliceAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: alice.id,
      kind: 'external_wallet',
    });
    const bobAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: bob.id,
      kind: 'external_wallet',
    });

    const { journalEntries, postings } = await import('./schema/index');
    await expect(
      db.transaction(async (tx) => {
        const [entry] = await tx
          .insert(journalEntries)
          .values({
            eventType: 'leg_checkin',
            refType: 'leg',
            refId: crypto.randomUUID(),
            idempotencyKey: 'test-3-bypass',
          })
          .returning({ id: journalEntries.id });
        if (!entry) throw new Error('insert failed');
        await tx.insert(postings).values([
          { journalEntryId: entry.id, accountId: aliceAccount, amountMsat: -1000n },
          { journalEntryId: entry.id, accountId: bobAccount, amountMsat: 999n }, // off by one sat
        ]);
      }),
    ).rejects.toThrow(/ledger invariant violated/);
  });

  it('idempotency: repeating the same key does not double-post', async () => {
    const db = await createTestDb();
    const [alice] = await db.insert(users).values({ email: 'alice4@example.com' }).returning();
    const [bob] = await db.insert(users).values({ email: 'bob4@example.com' }).returning();
    if (!alice || !bob) throw new Error('setup failed');
    const aliceAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: alice.id,
      kind: 'external_wallet',
    });
    const bobAccount = await findOrCreateAccount(db, {
      ownerType: 'user',
      ownerId: bob.id,
      kind: 'external_wallet',
    });

    const input = {
      eventType: 'leg_checkin',
      refType: 'leg' as const,
      refId: crypto.randomUUID(),
      idempotencyKey: 'test-4-idem',
      postings: [
        { accountId: aliceAccount, amountMsat: -500n },
        { accountId: bobAccount, amountMsat: 500n },
      ],
    };

    const id1 = await postJournalEntry(db, input);
    const id2 = await postJournalEntry(db, input);

    expect(id1).toBe(id2);
    expect(await getAccountBalance(db, bobAccount)).toBe(500n); // not 1000n
  });
});
