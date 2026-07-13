// The effect executor: the ONLY place where a shipment transition touches
// the world (ARCHITECTURE.md §2: "apps/api esegue gli effetti in transazione").
//
// The pure machine decides WHAT happens (states, amounts, custody events,
// ledger entries — ARCHITECTURE.md §5: "la macchina a stati è l'unica
// sorgente dei movimenti di denaro"); this module only executes, in three
// phases whose order is forced by the zero-custody design (ADR-013):
//
//  PHASE 1 — wallet I/O that must precede the commit:
//    - create_conditional_payment → coordinator.createConditionalPayment with
//      a deterministic idem key. When the machine pairs the create with an
//      immediate *_held ledger entry (origin/return hub bonds), the executor
//      WAITS for the hold to be observed held: those transitions certify a
//      bonded custodian, so they must not commit on a promise.
//    - request_instant_payment → settled synchronously: the certification the
//      fee gates stays locked until the payee's wallet confirms (ESCROW §3).
//    A failure here aborts everything; payments already created are
//    compensated with a best-effort refund (they reference ids minted for
//    THIS invocation only, so they can never belong to a concurrent winner)
//    and would in any case die with their hold window — the protocol's safe
//    default.
//
//  PHASE 2 — ONE database transaction:
//    - row lock on the shipment + in-tx recompute of the transition: if a
//      concurrent transition moved the aggregate, this one conflicts and
//      nothing half-happens (invariant 5);
//    - row projections (shipments/legs/hub_stays), the hash-chained custody
//      event, the shadow-ledger entries, the email outbox, the timer facts —
//      all or nothing.
//    Ledger entries paired to conditional payments derive the SAME
//    deterministic keys the coordinator uses — cp:<paymentId>:<transizione>
//    (ADR-013 §3) — so the two writes collapse into one and double counting
//    is impossible by construction.
//
//  PHASE 3 — release/refund verbs, right after commit. Both verbs are
//    idempotent; an escrow_intents row written INSIDE the transaction makes
//    them at-least-once (a worker retries leftovers). If the process dies
//    with the verb unexecuted, the committed state is already correct and
//    the money follows on retry — never the other way around.

import { randomInt } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import {
  carrierTrips,
  conditionalPayments,
  custodyEvents,
  emailOutbox,
  escrowIntents,
  findOrCreateAccount,
  hubStays,
  legs,
  postJournalEntry,
  rateObservations,
  shipments,
  shipmentTimers,
  users,
} from '@mercurio/db';
import { canonicalJson, custodyEventHash, transition, type DistanceProvider } from '@mercurio/core';
import type { EscrowCoordinator, WalletResolver } from '@mercurio/escrow';
import {
  LEG_FUNDING_WINDOW_MINUTES,
  type ShipmentContext,
  type ShipmentEffect,
  type ShipmentEvent,
  type ShipmentState,
} from '@mercurio/shared';
import { hashToken } from '../lib/tokens';
import {
  loadShipmentBundle,
  stateToDbStatus,
  type LegRow,
  type ShipmentBundle,
} from './context';
import { ConflictError, PaymentExecutionError, TransitionRejectedError } from './errors';
import { settleInstantPayment } from './instant';

export interface LifecycleDeps {
  db: Db;
  coordinator: EscrowCoordinator;
  resolveWallet: WalletResolver;
  distance: DistanceProvider;
  now: () => Date;
  /** Polling knobs for sync-held / instant settlement (tests tighten them). */
  waitAttempts?: number;
  waitDelayMs?: number;
}

export interface ExecuteArgs {
  shipmentId: string;
  event: ShipmentEvent;
  /** `create` only: the machine runs before any row exists, so the route
   *  builds the context; `persistBefore` must insert the shipment row. */
  createCtx?: ShipmentContext;
  /** Route-owned inserts that belong to the same transaction (the shipment
   *  row on create, the rejections row on handoff_reject). */
  persistBefore?: (tx: Db) => Promise<void>;
  /** Shipment columns rewritten by this transition (reroute freezes the new
   *  segment: dest hub, recipient, distance, segment work pool). */
  shipmentPatch?: Partial<typeof shipments.$inferInsert>;
  /** Transport metadata merged into the custody payload (e.g. the boost
   *  idempotency key). Never PII, never protocol data. */
  custodyPayloadExtra?: Record<string, unknown>;
  /** leg_accept only: row data the event does not carry. */
  legMeta?: { tripId: string; progressKm: number };
  /** Timer row this event consumes (set by fireDueTimers). */
  consumeTimerId?: string;
}

export interface ExecuteOutcome {
  nextState: ShipmentState;
  effects: ShipmentEffect[];
}

type CreateEffect = Extract<ShipmentEffect, { kind: 'create_conditional_payment' }>;
type LedgerEffect = Extract<ShipmentEffect, { kind: 'post_ledger_entry' }>;

const DEFAULT_WAIT_ATTEMPTS = 10;
const DEFAULT_WAIT_DELAY_MS = 200;

export async function executeShipmentTransition(
  deps: LifecycleDeps,
  args: ExecuteArgs,
): Promise<ExecuteOutcome> {
  const now = deps.now();
  const nowIso = now.toISOString();

  // ---- pure transition on a pre-transaction snapshot --------------------
  let preBundle: ShipmentBundle | null = null;
  if (!args.createCtx) {
    preBundle = await loadShipmentBundle(deps.db, args.shipmentId);
    if (!preBundle) throw new ConflictError(`shipment ${args.shipmentId} not found`);
  }
  const preState = preBundle ? preBundle.state : null;
  const preCtx = args.createCtx ?? preBundle!.ctx;
  const result = transition(preState, args.event, preCtx);
  if (!result.ok) throw new TransitionRejectedError(result.error);

  // ---- PHASE 1: conditional-payment creates + instant fees ---------------
  const createdIds = new Map<number, string>();
  try {
    for (let i = 0; i < result.effects.length; i += 1) {
      const effect = result.effects[i]!;
      if (effect.kind === 'create_conditional_payment') {
        const paymentId = await deps.coordinator.createConditionalPayment({
          shipmentId: preCtx.shipmentId,
          payerId: effect.payerId,
          payeeId: effect.payeeId,
          amountMsat: effect.amountMsat,
          purpose: effect.purpose,
          ref: effect.ref,
          holdWindowSeconds: LEG_FUNDING_WINDOW_MINUTES * 60,
          idem: `cpc:${effect.ref.type}:${effect.ref.id}:${effect.purpose}`,
        });
        createdIds.set(i, paymentId);
        const next = result.effects[i + 1];
        if (next?.kind === 'post_ledger_entry' && next.eventType.endsWith('_held')) {
          // The machine recognizes this commitment NOW (bonded custodian):
          // the transition must not commit unless the hold really is held.
          await waitUntilHeld(deps, paymentId);
        }
      } else if (effect.kind === 'request_instant_payment') {
        await settleInstantPayment(deps, preCtx.shipmentId, effect);
      }
    }
  } catch (err) {
    await compensateCreatedPayments(deps, createdIds);
    throw err;
  }

  // ---- PHASE 2: the single domain transaction ----------------------------
  const pendingVerbs: { paymentId: string; verb: 'release' | 'refund' }[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      let bundle: ShipmentBundle | null = null;
      let ctx = preCtx;
      if (!args.createCtx) {
        // Lock + recompute: the pre-transaction snapshot may be stale under
        // concurrency. Identical effects ⇒ identical money: comparing the
        // canonical form is the strongest cheap equality we have. Payments
        // minted by phase 1 of THIS invocation are not "the world moving on":
        // the recompute ignores them.
        bundle = await loadShipmentBundle(tx, args.shipmentId, {
          forUpdate: true,
          ignorePaymentIds: new Set(createdIds.values()),
        });
        if (!bundle) throw new ConflictError(`shipment ${args.shipmentId} disappeared`);
        const fresh = transition(bundle.state, args.event, bundle.ctx);
        if (!fresh.ok) {
          throw new ConflictError(
            `shipment ${args.shipmentId} moved on: ${fresh.error.code} on ${args.event.type}`,
          );
        }
        if (
          canonicalJson(fresh.effects as unknown) !== canonicalJson(result.effects as unknown)
        ) {
          throw new ConflictError(
            `shipment ${args.shipmentId} changed between snapshot and transaction`,
          );
        }
        ctx = bundle.ctx;
      }

      await args.persistBefore?.(tx);
      if (args.shipmentPatch) {
        await tx.update(shipments).set(args.shipmentPatch).where(eq(shipments.id, args.shipmentId));
      }

      const createdByKey = indexCreatedPayments(result.effects, createdIds);
      await projectRows(tx, deps, {
        event: args.event,
        bundle,
        createdByKey,
        now,
        legMeta: args.legMeta,
      });

      // Optimistic status flip: the WHERE clause is the last line of defense
      // against a concurrent transition that slipped between lock points.
      const fromStatus = preState ? stateToDbStatus(preState) : 'draft';
      const flipped = await tx
        .update(shipments)
        .set({ status: stateToDbStatus(result.nextState) })
        .where(and(eq(shipments.id, args.shipmentId), eq(shipments.status, fromStatus)))
        .returning({ id: shipments.id });
      if (flipped.length === 0) {
        throw new ConflictError(`shipment ${args.shipmentId} status changed concurrently`);
      }

      // Effects, in machine order (parcel_arrived reuses the OTP a preceding
      // rotate_pickup_otp minted; the ledger pairing walks adjacency).
      let chainTailHash = bundle?.chain.at(-1)?.hash ?? null;
      let mintedOtp: string | null = null;
      const recipientEmail =
        (args.shipmentPatch?.recipientEmail as string | undefined) ??
        bundle?.shipment.recipientEmail ??
        null;

      for (let i = 0; i < result.effects.length; i += 1) {
        const effect = result.effects[i]!;
        switch (effect.kind) {
          case 'create_conditional_payment':
          case 'request_instant_payment':
            break; // phase 1

          case 'release_conditional_payment':
          case 'refund_conditional_payment': {
            const verb = effect.kind === 'release_conditional_payment' ? 'release' : 'refund';
            await tx
              .insert(escrowIntents)
              .values({ paymentId: effect.paymentId, verb })
              .onConflictDoNothing({
                target: [escrowIntents.paymentId, escrowIntents.verb],
              });
            pendingVerbs.push({ paymentId: effect.paymentId, verb });
            break;
          }

          case 'post_ledger_entry': {
            const idem = deriveLedgerIdem(result.effects, i, ctx, createdIds);
            const postings = await Promise.all(
              effect.postings.map(async (p) => ({
                accountId: await findOrCreateAccount(tx, {
                  ownerType: p.ownerType,
                  ownerId: p.ownerId,
                  kind: p.accountKind,
                }),
                amountMsat: p.amountMsat,
              })),
            );
            await postJournalEntry(tx, {
              eventType: effect.eventType,
              refType: effect.ref.type,
              refId: effect.ref.id,
              idempotencyKey: idem,
              postings,
            });
            break;
          }

          case 'append_custody_event': {
            const payload = {
              ...effect.payload,
              ...(args.custodyPayloadExtra ?? {}),
            };
            const hash = custodyEventHash(
              {
                shipmentId: preCtx.shipmentId,
                type: effect.type,
                actorUserId: effect.actorUserId,
                legId: effect.legId,
                hubStayId: effect.hubStayId,
                payload,
                createdAt: nowIso,
              },
              chainTailHash,
            );
            await tx.insert(custodyEvents).values({
              shipmentId: preCtx.shipmentId,
              type: effect.type,
              actorUserId: effect.actorUserId,
              legId: effect.legId,
              hubStayId: effect.hubStayId,
              // Canonical storage: bigints become decimal strings, exactly
              // the form the hash was computed over — an auditor recomputes
              // the same hash from the stored row.
              payload: JSON.parse(canonicalJson(payload)) as Record<string, unknown>,
              prevEventHash: chainTailHash,
              hash,
              createdAt: now,
            });
            chainTailHash = hash;
            break;
          }

          case 'queue_email': {
            let to: string | null;
            if (effect.to === 'sender') {
              const [sender] = await tx
                .select({ email: users.email })
                .from(users)
                .where(eq(users.id, ctx.senderId));
              to = sender?.email ?? null;
            } else {
              to = recipientEmail;
            }
            if (!to) break; // anonymized sender: nothing to notify
            let payload: Record<string, unknown> = {
              ...effect.payload,
              shipmentId: preCtx.shipmentId,
            };
            if (effect.template === 'parcel_arrived') {
              // The pickup OTP travels in this email (flow step 7). Only the
              // hash is stored, so the plaintext must be minted here — unless
              // a rotate_pickup_otp in this same transition already did.
              if (!mintedOtp) {
                mintedOtp = await rotateOtp(tx, preCtx.shipmentId);
              }
              payload = { ...payload, otp: mintedOtp };
            }
            await tx.insert(emailOutbox).values({ to, template: effect.template, payload });
            break;
          }

          case 'rotate_pickup_otp': {
            mintedOtp = await rotateOtp(tx, preCtx.shipmentId);
            break;
          }

          case 'schedule_timeout': {
            await tx
              .insert(shipmentTimers)
              .values({
                shipmentId: preCtx.shipmentId,
                kind: effect.timeout,
                refId: effect.refId,
                fireAt: new Date(effect.at),
              })
              .onConflictDoUpdate({
                target: [shipmentTimers.kind, shipmentTimers.refId],
                set: { fireAt: new Date(effect.at) },
              });
            break;
          }

          case 'cancel_timeout': {
            await tx
              .delete(shipmentTimers)
              .where(
                and(eq(shipmentTimers.kind, effect.timeout), eq(shipmentTimers.refId, effect.refId)),
              );
            break;
          }
        }
      }

      if (args.consumeTimerId) {
        await tx.delete(shipmentTimers).where(eq(shipmentTimers.id, args.consumeTimerId));
      }
    });
  } catch (err) {
    await compensateCreatedPayments(deps, createdIds);
    throw err;
  }

  // ---- PHASE 3: coordinator verbs (idempotent, at-least-once) ------------
  for (const { paymentId, verb } of pendingVerbs) {
    try {
      if (verb === 'release') await deps.coordinator.release(paymentId, `cpv:${paymentId}:release`);
      else await deps.coordinator.refund(paymentId, `cpv:${paymentId}:refund`);
      await deps.db
        .delete(escrowIntents)
        .where(and(eq(escrowIntents.paymentId, paymentId), eq(escrowIntents.verb, verb)));
    } catch (err) {
      // The intent row survives; the worker retries until it sticks.
      console.warn(
        `escrow intent ${verb} ${paymentId} failed (worker will retry):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { nextState: result.nextState, effects: result.effects };
}

// ---------------------------------------------------------------------------
// Phase-1 helpers

async function waitUntilHeld(deps: LifecycleDeps, paymentId: string): Promise<void> {
  const attempts = deps.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
  const delayMs = deps.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await deps.coordinator.pollOnce();
    } catch (err) {
      console.warn('pollOnce failed while waiting for a hold:', err);
    }
    const [row] = await deps.db
      .select({ state: conditionalPayments.state })
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, paymentId));
    if (row?.state === 'held' || row?.state === 'settled') return;
    if (row?.state === 'cancelled' || row?.state === 'expired') break;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  throw new PaymentExecutionError(
    'hold_not_held',
    `conditional payment ${paymentId} was not held in time`,
  );
}

/** Best-effort cancellation of holds created by an invocation that will not
 *  commit. Safe: their refs contain ids minted for this invocation only, so
 *  they cannot belong to a concurrent winner; and if the refund itself fails
 *  they die with their hold window anyway (default sicuro, ESCROW §2). */
async function compensateCreatedPayments(
  deps: LifecycleDeps,
  createdIds: Map<number, string>,
): Promise<void> {
  for (const paymentId of createdIds.values()) {
    await deps.coordinator
      .refund(paymentId, `cpv:${paymentId}:refund`)
      .catch((err) =>
        console.warn(`compensating refund of ${paymentId} failed (hold will expire):`, err),
      );
  }
}

// ---------------------------------------------------------------------------
// Ledger idempotency pairing (ADR-013 §3)
//
// Every payment-coupled entry must reuse the coordinator's deterministic key
// cp:<paymentId>:<held|settled|refunded> so the two writes collapse. The
// machine emits each such entry IMMEDIATELY AFTER its payment effect; the one
// exception is leg_funded, whose held entries recognize payments created in
// an earlier transition — those resolve through the context.

function ledgerKind(eventType: string): 'held' | 'settled' | 'refunded' | null {
  if (eventType.endsWith('_held')) return 'held';
  if (eventType.endsWith('_released') || eventType.endsWith('_slashed')) return 'settled';
  if (eventType.endsWith('_refunded')) return 'refunded';
  return null;
}

function deriveLedgerIdem(
  effects: readonly ShipmentEffect[],
  index: number,
  ctx: ShipmentContext,
  createdIds: Map<number, string>,
): string {
  const entry = effects[index] as LedgerEffect;
  const kind = ledgerKind(entry.eventType);
  const prev = index > 0 ? effects[index - 1] : undefined;

  if (prev?.kind === 'request_instant_payment') {
    // Instant fees have no conditional payment: their own deterministic key.
    return `fee:${prev.ref.type}:${prev.ref.id}:${prev.reason}`;
  }
  if (prev?.kind === 'create_conditional_payment' && kind === 'held') {
    return `cp:${createdIds.get(index - 1)}:held`;
  }
  if (prev?.kind === 'release_conditional_payment' && kind === 'settled') {
    return `cp:${prev.paymentId}:settled`;
  }
  if (prev?.kind === 'refund_conditional_payment' && kind === 'refunded') {
    return `cp:${prev.paymentId}:refunded`;
  }

  // leg_funded: held entries for payments created at leg_accept.
  if (kind === 'held' && ctx.leg) {
    switch (entry.eventType) {
      case 'leg_payment_held':
        return `cp:${ctx.leg.legPaymentId}:held`;
      case 'carrier_bond_held':
        return `cp:${ctx.leg.carrierBondId}:held`;
      case 'hub_bond_held':
        return `cp:${ctx.leg.arrivalHubBondId}:held`;
      case 'finalization_bonus_held':
        if (ctx.finalizationBonusHold) return `cp:${ctx.finalizationBonusHold.paymentId}:held`;
    }
  }
  // Money must never be posted under a guessed key: fail the transition.
  throw new Error(`cannot derive ledger idempotency key for ${entry.eventType} at index ${index}`);
}

// ---------------------------------------------------------------------------
// Row projections
//
// The machine's effects deliberately do not include row DML (they are
// protocol facts, not schema); the executor owns the deterministic mapping
// event → rows, kept in ONE place so routes stay thin.

function indexCreatedPayments(
  effects: readonly ShipmentEffect[],
  createdIds: Map<number, string>,
): Map<string, string> {
  const byKey = new Map<string, string>();
  effects.forEach((effect, i) => {
    if (effect.kind === 'create_conditional_payment') {
      const id = createdIds.get(i);
      if (id) byKey.set(`${effect.purpose}|${effect.ref.type}|${effect.ref.id}`, id);
    }
  });
  return byKey;
}

interface ProjectionInput {
  event: ShipmentEvent;
  bundle: ShipmentBundle | null;
  createdByKey: Map<string, string>;
  now: Date;
  legMeta?: { tripId: string; progressKm: number } | undefined;
}

async function projectRows(tx: Db, deps: LifecycleDeps, input: ProjectionInput): Promise<void> {
  const { event, bundle, createdByKey, now } = input;
  const mustCreated = (key: string): string => {
    const id = createdByKey.get(key);
    if (!id) throw new Error(`no conditional payment was created for ${key}`);
    return id;
  };

  switch (event.type) {
    case 'create':
    case 'boost':
    case 'reroute': // shipmentPatch carries the column changes
    case 'handoff_reject': // persistBefore carries the rejections row
      return;

    case 'origin_hub_accept': {
      const shipment = bundle!.shipment;
      await tx.insert(hubStays).values({
        id: event.hubStayId,
        shipmentId: shipment.id,
        hubId: shipment.originHubId,
        seq: await nextStaySeq(tx, shipment.id),
        status: 'reserved',
        reservedAt: now,
        bondConditionalPaymentId: mustCreated(`custody_bond|hub_stay|${event.hubStayId}`),
      });
      return;
    }

    case 'origin_checkin': {
      const stay = bundle!.currentStayRow!;
      await tx
        .update(hubStays)
        .set({
          status: 'active',
          checkedInAt: now,
          storageDeadlineAt: new Date(event.storageDeadlineAt),
        })
        .where(eq(hubStays.id, stay.id));
      return;
    }

    case 'leg_accept': {
      const shipment = bundle!.shipment;
      const meta = input.legMeta;
      if (!meta) throw new Error('leg_accept requires legMeta (tripId, progressKm)');
      await tx.insert(legs).values({
        id: event.legId,
        shipmentId: shipment.id,
        seq: await nextLegSeq(tx, shipment.id),
        carrierId: event.carrierId,
        tripId: meta.tripId,
        fromHubId: bundle!.currentStayRow!.hubId,
        toHubId: event.toHubId,
        status: 'pending_funding',
        acceptedAt: now,
        fundingDeadlineAt: new Date(event.fundingDeadlineAt),
        progressKm: meta.progressKm,
        grossMsat: event.pricing.grossMsat,
        depHubFeeMsat: event.pricing.depHubFeeMsat,
        arrHubFeeMsat: event.pricing.arrHubFeeMsat,
        netMsat: event.pricing.netMsat,
        finalizationBonusMsat: event.pricing.finalizationBonusMsat,
        paymentConditionalPaymentId: mustCreated(`leg_payment|leg|${event.legId}`),
        bondConditionalPaymentId: mustCreated(`custody_bond|leg|${event.legId}`),
      });
      await tx.insert(hubStays).values({
        id: event.arrivalHubStayId,
        shipmentId: shipment.id,
        hubId: event.toHubId,
        seq: await nextStaySeq(tx, shipment.id),
        status: 'reserved',
        reservedAt: now,
        bondConditionalPaymentId: mustCreated(`custody_bond|hub_stay|${event.arrivalHubStayId}`),
      });
      return;
    }

    case 'leg_funded': {
      const leg = bundle!.activeLegRow!;
      await tx
        .update(legs)
        .set({ status: 'booked', pickupDeadlineAt: new Date(event.pickupDeadlineAt) })
        .where(eq(legs.id, leg.id));
      return;
    }

    case 'leg_funding_expired': {
      await expireLegAndArrival(tx, bundle!, 'expired');
      return;
    }

    case 'pickup_checkout': {
      const leg = bundle!.activeLegRow!;
      const stay = bundle!.currentStayRow!;
      await tx
        .update(legs)
        .set({ status: 'picked_up', transitDeadlineAt: new Date(event.transitDeadlineAt) })
        .where(eq(legs.id, leg.id));
      await tx
        .update(hubStays)
        .set({ status: 'released', checkedOutAt: now })
        .where(eq(hubStays.id, stay.id));
      return;
    }

    case 'pickup_timeout': {
      await expireLegAndArrival(tx, bundle!, 'failed');
      return;
    }

    case 'leg_checkin': {
      const leg = bundle!.activeLegRow!;
      const arrival = bundle!.arrivalStayRow!;
      await tx.update(legs).set({ status: 'completed' }).where(eq(legs.id, leg.id));
      await tx
        .update(hubStays)
        .set({
          status: 'active',
          checkedInAt: now,
          storageDeadlineAt: new Date(event.storageDeadlineAt),
        })
        .where(eq(hubStays.id, arrival.id));
      await recordRateObservation(tx, deps, bundle!, leg);
      return;
    }

    case 'leg_return': {
      const leg = bundle!.activeLegRow!;
      const arrival = bundle!.arrivalStayRow!;
      await tx.update(legs).set({ status: 'returned' }).where(eq(legs.id, leg.id));
      await tx.update(hubStays).set({ status: 'expired' }).where(eq(hubStays.id, arrival.id));
      await tx.insert(hubStays).values({
        id: event.returnHubStayId,
        shipmentId: bundle!.shipment.id,
        hubId: leg.fromHubId,
        seq: await nextStaySeq(tx, bundle!.shipment.id),
        status: 'active',
        reservedAt: now,
        checkedInAt: now,
        storageDeadlineAt: new Date(event.storageDeadlineAt),
        bondConditionalPaymentId: mustCreated(`custody_bond|hub_stay|${event.returnHubStayId}`),
      });
      return;
    }

    case 'recipient_pickup': {
      const stay = bundle!.currentStayRow!;
      await tx
        .update(hubStays)
        .set({ status: 'released', checkedOutAt: now })
        .where(eq(hubStays.id, stay.id));
      return;
    }

    case 'storage_expiry': {
      const stay = bundle!.currentStayRow!;
      await tx.update(hubStays).set({ status: 'expired' }).where(eq(hubStays.id, stay.id));
      if (bundle!.activeLegRow) {
        // A leg still pending funding dies with the storage (§5 decision 4).
        await expireLegAndArrival(tx, bundle!, 'expired');
      }
      return;
    }

    case 'transit_timeout': {
      await expireLegAndArrival(tx, bundle!, 'failed');
      return;
    }

    case 'cancel': {
      const stay = bundle?.currentStayRow;
      if (stay) {
        await tx
          .update(hubStays)
          .set({ status: 'released', checkedOutAt: now })
          .where(eq(hubStays.id, stay.id));
      }
      return;
    }
  }
}

async function expireLegAndArrival(
  tx: Db,
  bundle: ShipmentBundle,
  legStatus: 'expired' | 'failed',
): Promise<void> {
  const leg = bundle.activeLegRow!;
  await tx.update(legs).set({ status: legStatus }).where(eq(legs.id, leg.id));
  if (bundle.arrivalStayRow) {
    await tx
      .update(hubStays)
      .set({ status: 'expired' })
      .where(eq(hubStays.id, bundle.arrivalStayRow.id));
  }
}

/** Feed the carrier-rate suggester (MATCHING.md §4): only legs that were
 *  accepted AND completed land here, valued at what the carrier actually
 *  collected (net + delivery bonus) over the detour of their declared trip. */
async function recordRateObservation(
  tx: Db,
  deps: LifecycleDeps,
  bundle: ShipmentBundle,
  leg: LegRow,
): Promise<void> {
  const [trip] = await tx.select().from(carrierTrips).where(eq(carrierTrips.id, leg.tripId));
  const fromHub = bundle.hubById.get(leg.fromHubId);
  const toHub = bundle.hubById.get(leg.toHubId);
  if (!trip || !fromHub || !toHub) return; // observation is best-effort, money is not
  const d = deps.distance.distanceKm.bind(deps.distance);
  const origin = { lat: trip.originLat, lng: trip.originLng };
  const dest = { lat: trip.destLat, lng: trip.destLng };
  const s = { lat: fromHub.lat, lng: fromHub.lng };
  const h = { lat: toHub.lat, lng: toHub.lng };
  const detourKm = Math.max(0, d(origin, s) + d(s, h) + d(h, dest) - d(origin, dest));
  await tx.insert(rateObservations).values({
    legId: leg.id,
    detourKm,
    netMsat: leg.netMsat + leg.finalizationBonusMsat,
    eurRate: bundle.shipment.eurRateSnapshot,
    acceptedAt: leg.acceptedAt,
  });
}

async function nextStaySeq(tx: Db, shipmentId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${hubStays.seq}), -1)::int` })
    .from(hubStays)
    .where(eq(hubStays.shipmentId, shipmentId));
  return (row?.max ?? -1) + 1;
}

async function nextLegSeq(tx: Db, shipmentId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${legs.seq}), -1)::int` })
    .from(legs)
    .where(eq(legs.shipmentId, shipmentId));
  return (row?.max ?? -1) + 1;
}

// ---------------------------------------------------------------------------

/** 6-digit pickup OTP; only its hash is stored (same rationale as session
 *  tokens: a DB read alone cannot collect a parcel). */
async function rotateOtp(tx: Db, shipmentId: string): Promise<string> {
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx
    .update(shipments)
    .set({ recipientPickupOtpHash: hashToken(otp) })
    .where(eq(shipments.id, shipmentId));
  return otp;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
