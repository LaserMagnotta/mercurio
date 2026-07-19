// Shared BlobStore contract (ADR-020 §1, ADR-023 §6): every driver — memory,
// fs, S3 — must satisfy the same put/get/delete/list/idempotency behavior.
// `blob-store.test.ts` runs this against memory and fs; the S3 driver runs
// the identical assertions in `blob-store.s3.integration.test.ts` against a
// real MinIO, so the driver swap promised by ADR-020/ADR-023 is verified,
// not just assumed.

import { describe, expect, it } from 'vitest';
import { sha256Hex, type BlobStore } from './blob-store.js';

export function runBlobStoreContractTests(
  name: string,
  createStore: () => BlobStore | Promise<BlobStore>,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    it('get on a missing key returns null', async () => {
      const store = await createStore();
      const key = sha256Hex(Buffer.from(`${name}-missing`));
      expect(await store.get(key)).toBeNull();
    });

    it('put then get returns exactly the same bytes', async () => {
      const store = await createStore();
      const bytes = Buffer.from(`${name}-hello`);
      const key = sha256Hex(bytes);
      await store.put(key, bytes);
      expect(await store.get(key)).toEqual(bytes);
    });

    it('put is idempotent: same key and bytes twice, no error', async () => {
      const store = await createStore();
      const bytes = Buffer.from(`${name}-idempotent`);
      const key = sha256Hex(bytes);
      await store.put(key, bytes);
      await expect(store.put(key, bytes)).resolves.not.toThrow();
      expect(await store.get(key)).toEqual(bytes);
    });

    it('delete removes the blob; deleting a missing key is a no-op', async () => {
      const store = await createStore();
      const bytes = Buffer.from(`${name}-to-delete`);
      const key = sha256Hex(bytes);
      await store.put(key, bytes);
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      await expect(store.delete(key)).resolves.not.toThrow();
    });

    it('list reports every stored key with a modifiedAt', async () => {
      const store = await createStore();
      const a = Buffer.from(`${name}-list-a`);
      const b = Buffer.from(`${name}-list-b`);
      const keyA = sha256Hex(a);
      const keyB = sha256Hex(b);
      await store.put(keyA, a);
      await store.put(keyB, b);
      const entries = await store.list();
      const byKey = new Map(entries.map((e) => [e.key, e]));
      expect(byKey.get(keyA)?.modifiedAt).toBeInstanceOf(Date);
      expect(byKey.get(keyB)?.modifiedAt).toBeInstanceOf(Date);
    });

    it('rejects a malformed (non-sha256) key', async () => {
      const store = await createStore();
      await expect(store.put('not-a-sha256', Buffer.from('x'))).rejects.toThrow();
    });
  });
}
