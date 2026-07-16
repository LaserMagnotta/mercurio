// Uniform mapping of lifecycle failures to HTTP. The pure machine's typed
// errors become 409/422 (protocol says no), payment-execution failures 402
// (a wallet did not do its part), conflicts 409. Anything else bubbles to
// fastify's 500 handler — a bug, not a client error.

import type { FastifyReply } from 'fastify';
import { EconomicsError } from '@mercurio/core';
import { ConflictError, PaymentExecutionError, TransitionRejectedError } from '../shipments/errors';
import { WalletCapabilityError, WalletUnavailableError } from '../lib/wallets';

export async function replyLifecycleError(reply: FastifyReply, err: unknown): Promise<boolean> {
  if (err instanceof TransitionRejectedError) {
    const status = err.detail.code === 'illegal_event' ? 409 : 422;
    await reply.code(status).send({ error: err.detail.code, message: err.detail.message });
    return true;
  }
  if (err instanceof ConflictError) {
    await reply.code(409).send({ error: 'conflict', message: err.message });
    return true;
  }
  if (err instanceof PaymentExecutionError) {
    await reply.code(402).send({ error: err.code, message: err.message });
    return true;
  }
  if (err instanceof WalletCapabilityError) {
    await reply.code(402).send({ error: 'wallet_missing_hold_support', message: err.message });
    return true;
  }
  if (err instanceof WalletUnavailableError) {
    await reply.code(402).send({ error: 'wallet_unavailable', message: err.message });
    return true;
  }
  if (err instanceof EconomicsError) {
    await reply.code(422).send({ error: err.code, message: err.message });
    return true;
  }
  return false;
}
