import { eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { accounts, journalEntries, postings } from './schema/index';

export interface PostingInput {
  accountId: string;
  amountMsat: bigint;
}

export interface PostJournalEntryInput {
  eventType: string;
  refType: string;
  refId: string;
  idempotencyKey: string;
  postings: PostingInput[];
}

/**
 * Writes one journal entry and its postings inside a transaction.
 *
 * No balance is ever cached: every balance is `SUM(postings.amount_msat)`
 * computed at read time (see `getAccountBalance`). The postings-sum-to-zero
 * invariant is enforced twice - here, fast, before touching the database,
 * and again by a deferred constraint trigger in the database itself
 * (0001_ledger_balance_trigger.sql) - because "nessuna logica di denaro
 * senza test" means the code must not be the only thing standing between a
 * bug and an unbalanced ledger (ADR-010, CLAUDE.md).
 *
 * Idempotent: a repeated call with the same `idempotencyKey` is a no-op
 * (the unique constraint on journal_entries.idempotency_key rejects the
 * duplicate insert; we catch that specific case and return the existing id).
 */
export async function postJournalEntry(db: Db, input: PostJournalEntryInput): Promise<string> {
  if (input.postings.length < 2) {
    throw new Error('postJournalEntry: at least two postings are required');
  }
  const sum = input.postings.reduce((acc, p) => acc + p.amountMsat, 0n);
  if (sum !== 0n) {
    throw new Error(
      `postJournalEntry: postings must sum to zero, got ${sum} for event ${input.eventType}`,
    );
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        eventType: input.eventType,
        refType: input.refType,
        refId: input.refId,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: journalEntries.idempotencyKey })
      .returning({ id: journalEntries.id });

    if (!entry) {
      // Already posted under this idempotency key: return the existing entry, do nothing else.
      const [existing] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(eq(journalEntries.idempotencyKey, input.idempotencyKey));
      if (!existing) throw new Error('postJournalEntry: conflict but no existing row found');
      return existing.id;
    }

    await tx.insert(postings).values(
      input.postings.map((p) => ({
        journalEntryId: entry.id,
        accountId: p.accountId,
        amountMsat: p.amountMsat,
      })),
    );

    return entry.id;
  });
}

/** Always computed from postings - never a stored/cached balance. */
export async function getAccountBalance(db: Db, accountId: string): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${postings.amountMsat}), 0)` })
    .from(postings)
    .where(eq(postings.accountId, accountId));
  return BigInt(row?.total ?? '0');
}

export async function findOrCreateAccount(
  db: Db,
  params: {
    ownerType: 'user' | 'shipment';
    ownerId: string;
    kind: 'external_wallet' | 'commitment';
  },
): Promise<string> {
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      sql`${accounts.ownerType} = ${params.ownerType} AND ${accounts.ownerId} = ${params.ownerId} AND ${accounts.kind} = ${params.kind}`,
    );
  if (existing) return existing.id;

  const [created] = await db
    .insert(accounts)
    .values({ ownerType: params.ownerType, ownerId: params.ownerId, kind: params.kind })
    .returning({ id: accounts.id });
  if (!created) throw new Error('findOrCreateAccount: insert returned no row');
  return created.id;
}
