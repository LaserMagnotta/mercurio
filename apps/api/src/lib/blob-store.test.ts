// Unit-level BlobStore drivers (ADR-020, ADR-023): memory and fs run the
// shared contract in-process, on disk under a throwaway temp directory. The
// S3 driver runs the same contract against a real MinIO in
// blob-store.s3.integration.test.ts (needs the docker-compose "s3" profile).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe } from 'vitest';
import { createFsBlobStore, createMemoryBlobStore } from './blob-store.js';
import { runBlobStoreContractTests } from './blob-store.contract.js';

runBlobStoreContractTests('memory', () => createMemoryBlobStore());

describe('fs driver temp directory lifecycle', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mercurio-blob-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runBlobStoreContractTests('fs', () => createFsBlobStore(root));
});
