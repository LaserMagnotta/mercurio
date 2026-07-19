// Uniform mapping of the routes' known failures to HTTP. The pure machine's
// typed errors become 409/422 (protocol says no), payment-execution failures
// 402 (a wallet did not do its part), conflicts 409, an unusable EUR rate 503
// (nothing is wrong with the request — come back in a minute). Anything else
// bubbles to fastify's 500 handler — a bug, not a client error.

import type { FastifyReply } from 'fastify';
import { EconomicsError } from '@mercurio/core';
import { ConflictError, PaymentExecutionError, TransitionRejectedError } from '../shipments/errors.js';
import { WalletCapabilityError, WalletUnavailableError } from '../lib/wallets.js';
import { EurRateUnavailableError } from '../lib/eur-rate.js';

export async function replyLifecycleError(reply: FastifyReply, err: unknown): Promise<boolean> {
  // Transient and nobody's fault: the ticker feeds are unreachable, or their
  // last value is too old to freeze into a shipment for life (ADR-025 §5).
  if (err instanceof EurRateUnavailableError) {
    await reply
      .code(503)
      .header('Retry-After', '60')
      .send({ error: 'eur_rate_unavailable', message: err.message });
    return true;
  }
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
