// Minimal Nostr relay transport for NWC (NIP-47, ADR-019): request/response
// only — publish one request event, wait for the one matching reply. No
// persistent session, no subscription bookkeeping across calls: Mercurio's
// NWC calls happen at protocol milestones (leg acceptance, settlement), not
// in a hot loop, so a fresh relay connection per call trades a little
// latency for a lot less state to get wrong.
//
// A relay is untrusted transport (it could be malicious or compromised): any
// reply is independently verified here (id hash, signature, tags) before the
// adapter ever sees its decrypted content.

import { randomBytes } from 'node:crypto';
import { verifyEvent, type NostrEvent } from './event';

export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  '#e'?: string[];
  '#p'?: string[];
}

export interface NwcTransport {
  /** Publish `request`, then wait up to `timeoutMs` for one event matching
   *  `replyFilter` whose signature verifies. */
  request(request: NostrEvent, replyFilter: NostrFilter, timeoutMs: number): Promise<NostrEvent>;
}

export class NwcTimeoutError extends Error {}
export class NwcRelayError extends Error {}

function matchesFilter(evt: NostrEvent, filter: NostrFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(evt.kind)) return false;
  if (filter.authors && !filter.authors.includes(evt.pubkey)) return false;
  const eTags = evt.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
  if (filter['#e'] && !filter['#e'].some((id) => eTags.includes(id))) return false;
  const pTags = evt.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
  if (filter['#p'] && !filter['#p'].some((pk) => pTags.includes(pk))) return false;
  return true;
}

/** Real relay transport: opens a plain WebSocket per call (Node 22+ has a
 *  native global `WebSocket`, so no extra dependency is needed). Tries each
 *  configured relay URL in order until one connects. */
export class WebSocketNwcTransport implements NwcTransport {
  constructor(private readonly relayUrls: string[]) {
    if (relayUrls.length === 0) throw new NwcRelayError('nwc: connection string has no relay');
  }

  async request(
    requestEvent: NostrEvent,
    replyFilter: NostrFilter,
    timeoutMs: number,
  ): Promise<NostrEvent> {
    const ws = await this.connectFirstReachable(timeoutMs);
    try {
      return await roundTrip(ws, requestEvent, replyFilter, timeoutMs);
    } finally {
      ws.close();
    }
  }

  private async connectFirstReachable(timeoutMs: number): Promise<WebSocket> {
    let lastError: unknown;
    for (const url of this.relayUrls) {
      try {
        return await openSocket(url, timeoutMs);
      } catch (err) {
        lastError = err;
      }
    }
    throw new NwcRelayError(
      `could not reach any relay (${this.relayUrls.join(', ')}): ${String(lastError)}`,
    );
  }
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new NwcTimeoutError(`relay ${url} did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new NwcRelayError(`relay ${url} connection error`));
      },
      { once: true },
    );
  });
}

function roundTrip(
  ws: WebSocket,
  requestEvent: NostrEvent,
  replyFilter: NostrFilter,
  timeoutMs: number,
): Promise<NostrEvent> {
  return new Promise((resolve, reject) => {
    const subId = randomBytes(8).toString('hex');
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        // socket may already be closing; the fresh per-call connection is
        // torn down right after anyway.
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new NwcTimeoutError(`no reply within ${timeoutMs}ms`)));
    }, timeoutMs);

    const onMessage = (ev: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 'OK' && frame[1] === requestEvent.id && frame[2] === false) {
        finish(() => reject(new NwcRelayError(`relay rejected the request: ${String(frame[3])}`)));
        return;
      }
      if (frame[0] === 'EVENT' && frame[1] === subId) {
        const candidate = frame[2] as NostrEvent;
        if (matchesFilter(candidate, replyFilter) && verifyEvent(candidate)) {
          finish(() => resolve(candidate));
        }
        // else: keep waiting — a relay is untrusted, garbage is ignored.
      }
    };
    ws.addEventListener('message', onMessage);

    ws.send(JSON.stringify(['REQ', subId, replyFilter]));
    ws.send(JSON.stringify(['EVENT', requestEvent]));
  });
}
