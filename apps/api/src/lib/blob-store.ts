// Photo blob storage (ADR-020). A minimal interface in the repo's usual
// style (WalletConnection, DistanceProvider): routes and workers depend on
// this boundary, so swapping the MVP filesystem driver for an S3-compatible
// one (future ADR) never touches them.
//
// Keys are the photos' sha256 (the schema's natural key): the store is
// content-addressed by construction — same bytes, same key, same path — so
// `put` is idempotent and a blob can back several `photos` rows. Physical
// deletion is the caller's job to gate on the row refcount (ADR-020 §1).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BlobEntry {
  key: string;
  /** Last-modified time, used by the orphan sweep (ADR-020 §5). */
  modifiedAt: Date;
}

export interface BlobStore {
  /** Returns the bytes, or null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Idempotent content-addressed write (same key ⇒ same bytes). */
  put(key: string, bytes: Buffer): Promise<void>;
  /** Idempotent delete (missing keys are a no-op). */
  delete(key: string): Promise<void>;
  /** Every stored blob — MVP volumes are small (used by the orphan sweep). */
  list(): Promise<BlobEntry[]>;
}

/** Lowercase hex sha256 of raw bytes (server side of the client contract in
 *  apps/web/lib/photo-hash.ts: the API VERIFIES the declared hash, it never
 *  replaces it). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const KEY_RE = /^[0-9a-f]{64}$/;

/** Two-level fan-out (`ab/abcdef…`) keeps directories small without a real
 *  need for more depth at MVP volumes. */
function keyPath(root: string, key: string): { dir: string; file: string } {
  if (!KEY_RE.test(key)) throw new Error(`blob store: malformed key ${key}`);
  const dir = join(root, key.slice(0, 2));
  return { dir, file: join(dir, key) };
}

/**
 * Filesystem driver (ADR-020 §1): PHOTO_STORAGE_DIR, no containers, no bind
 * mounts (the ADR-004 root-ownership problem cannot occur). Writes are
 * atomic: temp file + rename, so a crash never leaves a half-written blob
 * behind under the final name.
 */
export function createFsBlobStore(root: string): BlobStore {
  return {
    async get(key) {
      try {
        return await readFile(keyPath(root, key).file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async put(key, bytes) {
      const { dir, file } = keyPath(root, key);
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    },
    async delete(key) {
      await rm(keyPath(root, key).file, { force: true });
    },
    async list() {
      let shards: string[];
      try {
        shards = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const entries: BlobEntry[] = [];
      for (const shard of shards) {
        let files: string[];
        try {
          files = await readdir(join(root, shard));
        } catch {
          continue; // a stray file at the root level is not ours to touch
        }
        for (const name of files) {
          if (!KEY_RE.test(name)) continue; // skip temp files mid-write
          const info = await stat(join(root, shard, name));
          entries.push({ key: name, modifiedAt: info.mtime });
        }
      }
      return entries;
    },
  };
}

/** In-memory driver for tests (pglite-style: no disk, injectable clock not
 *  needed — `modifiedAt` is set at put time). */
export function createMemoryBlobStore(now: () => Date = () => new Date()): BlobStore {
  const blobs = new Map<string, { bytes: Buffer; modifiedAt: Date }>();
  return {
    async get(key) {
      return blobs.get(key)?.bytes ?? null;
    },
    async put(key, bytes) {
      if (!KEY_RE.test(key)) throw new Error(`blob store: malformed key ${key}`);
      blobs.set(key, { bytes, modifiedAt: now() });
    },
    async delete(key) {
      blobs.delete(key);
    },
    async list() {
      return [...blobs.entries()].map(([key, v]) => ({ key, modifiedAt: v.modifiedAt }));
    },
  };
}
