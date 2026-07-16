// Shared plumbing for the regtest integration suites (ADR-004, ADR-019):
// raw LND REST access for assertions the WalletConnection interface does not
// (and should not) expose — node info, channel state, channel balances —
// plus a generic polling helper. Real channel-balance assertions are what
// keep these suites honest (CLAUDE.md: money logic is never validated on
// mocks alone), regardless of which adapter is under test.

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

export const NODES = {
  alice: process.env.LND_ALICE_REST ?? 'https://127.0.0.1:8081',
  bob: process.env.LND_BOB_REST ?? 'https://127.0.0.1:8082',
  carol: process.env.LND_CAROL_REST ?? 'https://127.0.0.1:8083',
} as const;
export type NodeName = keyof typeof NODES;

export const VOLUMES = fileURLToPath(new URL('../../../../infra/docker/volumes/', import.meta.url));

export function macaroonHex(node: NodeName): string {
  const path = `${VOLUMES}lnd-${node}/data/chain/bitcoin/regtest/admin.macaroon`;
  return readFileSync(path).toString('hex');
}

/** Raw REST call for assertions the WalletConnection interface does not
 *  (and should not) expose: getinfo, channel list, channel balance. */
export function lndGet(node: NodeName, path: string): Promise<Record<string, unknown>> {
  const url = new URL(NODES[node]);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'GET',
        host: url.hostname,
        port: Number(url.port),
        path,
        headers: { 'Grpc-Metadata-macaroon': macaroonHex(node) },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 300) resolve(JSON.parse(data));
          else reject(new Error(`${node} GET ${path}: ${res.statusCode} ${data.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function localBalanceMsat(node: NodeName): Promise<bigint> {
  const res = (await lndGet(node, '/v1/balance/channels')) as {
    local_balance?: { msat?: string };
  };
  return BigInt(res.local_balance?.msat ?? '0');
}

/** Preflight: node reachable, synced, channels active — otherwise fail with
 *  instructions instead of forty timeouts. */
export async function preflightNode(node: NodeName): Promise<void> {
  const info = (await lndGet(node, '/v1/getinfo').catch((err) => {
    throw new Error(
      `lnd-${node} unreachable (${err}). Start the environment first:\n` +
        '  docker compose -f infra/docker/docker-compose.yml up -d\n' +
        '  ./infra/docker/bootstrap.sh',
    );
  })) as { synced_to_chain?: boolean };
  if (!info.synced_to_chain) throw new Error(`lnd-${node} not synced to chain`);
  const channels = (await lndGet(node, '/v1/channels?active_only=true')) as {
    channels?: unknown[];
  };
  if (!channels.channels?.length) {
    throw new Error(`lnd-${node} has no active channels — run infra/docker/bootstrap.sh`);
  }
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
