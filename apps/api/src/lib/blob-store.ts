// Photo blob storage (ADR-020, ADR-023). A minimal interface in the repo's
// usual style (WalletConnection, DistanceProvider): routes and workers
// depend on this boundary, so choosing the S3-compatible driver over the
// MVP filesystem one (ADR-023) never touches them.
//
// Keys are the photos' sha256 (the schema's natural key): the store is
// content-addressed by construction — same bytes, same key, same path — so
// `put` is idempotent and a blob can back several `photos` rows. Physical
// deletion is the caller's job to gate on the row refcount (ADR-020 §1).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

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

export interface S3BlobStoreConfig {
  endpoint: string;
  bucket: string;
  /** Conventional value for MinIO/Garage, which do not route by region. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO/Garage need path-style (`endpoint/bucket/key`); real S3 supports
   *  virtual-hosted style too. Default true (the two ADR-023 targets). */
  forcePathStyle?: boolean;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * S3-compatible driver (ADR-023): any client speaking the S3 API (MinIO,
 * Garage, S3 itself) behind the same `BlobStore` interface as the fs driver.
 * Object key = sha256 directly — the fs driver's two-level fan-out exists
 * only to keep filesystem directories small, which does not apply to an
 * object store at MVP volumes. `put` needs no temp-file dance: a `PutObject`
 * is already atomic at the object level, so a concurrent `get` never
 * observes partial bytes.
 */
export function createS3BlobStore(config: S3BlobStoreConfig): BlobStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const bucket = config.bucket;

  return {
    async get(key) {
      if (!KEY_RE.test(key)) throw new Error(`blob store: malformed key ${key}`);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await res.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async put(key, bytes) {
      if (!KEY_RE.test(key)) throw new Error(`blob store: malformed key ${key}`);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    },
    async delete(key) {
      if (!KEY_RE.test(key)) throw new Error(`blob store: malformed key ${key}`);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list() {
      const entries: BlobEntry[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
        );
        for (const obj of res.Contents ?? []) {
          if (!obj.Key || !obj.LastModified || !KEY_RE.test(obj.Key)) continue;
          entries.push({ key: obj.Key, modifiedAt: obj.LastModified });
        }
        continuationToken = res.NextContinuationToken;
      } while (continuationToken);
      return entries;
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`blob store: ${name} is required when PHOTO_STORAGE_DRIVER=s3`);
  }
  return value;
}

/**
 * Picks the driver from config (ADR-023): `PHOTO_STORAGE_DRIVER` defaults to
 * `fs` (ADR-020, unchanged for single-replica deploys). `s3` requires every
 * `PHOTO_STORAGE_S3_*` credential explicitly — a missing one fails loudly at
 * startup rather than silently falling back to a driver nobody chose.
 */
export function createBlobStoreFromEnv(): BlobStore {
  const driver = process.env.PHOTO_STORAGE_DRIVER ?? 'fs';
  if (driver === 'fs') {
    return createFsBlobStore(process.env.PHOTO_STORAGE_DIR ?? './data/photos');
  }
  if (driver === 's3') {
    return createS3BlobStore({
      endpoint: requireEnv('PHOTO_STORAGE_S3_ENDPOINT'),
      bucket: requireEnv('PHOTO_STORAGE_S3_BUCKET'),
      ...(process.env.PHOTO_STORAGE_S3_REGION !== undefined && {
        region: process.env.PHOTO_STORAGE_S3_REGION,
      }),
      accessKeyId: requireEnv('PHOTO_STORAGE_S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('PHOTO_STORAGE_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.PHOTO_STORAGE_S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  throw new Error(`blob store: unknown PHOTO_STORAGE_DRIVER "${driver}" (expected fs or s3)`);
}

/**
 * Venue-photo store (ADR-028): the SAME driver as the shipment photo store but
 * a SEPARATE location. It must never share the shipment store's directory or
 * bucket, because the shipment purge worker's orphan sweep (ADR-020 §5) deletes
 * any blob with no `photos` row — and venue blobs have none. So the venue store
 * gets its own root (`VENUE_PHOTO_STORAGE_DIR`, default `./data/venue-photos`)
 * or its own bucket (`PHOTO_STORAGE_S3_VENUE_BUCKET`), and the purge worker only
 * ever sees the shipment store.
 */
export function createVenueBlobStoreFromEnv(): BlobStore {
  const driver = process.env.PHOTO_STORAGE_DRIVER ?? 'fs';
  if (driver === 'fs') {
    return createFsBlobStore(process.env.VENUE_PHOTO_STORAGE_DIR ?? './data/venue-photos');
  }
  if (driver === 's3') {
    return createS3BlobStore({
      endpoint: requireEnv('PHOTO_STORAGE_S3_ENDPOINT'),
      bucket: requireEnv('PHOTO_STORAGE_S3_VENUE_BUCKET'),
      ...(process.env.PHOTO_STORAGE_S3_REGION !== undefined && {
        region: process.env.PHOTO_STORAGE_S3_REGION,
      }),
      accessKeyId: requireEnv('PHOTO_STORAGE_S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('PHOTO_STORAGE_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.PHOTO_STORAGE_S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  throw new Error(`blob store: unknown PHOTO_STORAGE_DRIVER "${driver}" (expected fs or s3)`);
}
