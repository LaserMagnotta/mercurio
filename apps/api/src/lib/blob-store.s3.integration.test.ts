// S3 driver against a REAL MinIO (ADR-023 §6): same contract the memory/fs
// drivers pass in blob-store.test.ts, exercised here over the network so
// path-style addressing, NoSuchKey handling and list pagination are actually
// verified against the S3 API, not just assumed from reading the SDK docs.
//
//   docker compose -f infra/docker/docker-compose.yml up -d minio
//   pnpm --filter @mercurio/api test:integration

import { BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll } from 'vitest';
import { createS3BlobStore } from './blob-store';
import { runBlobStoreContractTests } from './blob-store.contract';

// Defaults match the docker-compose "minio" service (ADR-023 §5) so the
// suite runs with zero configuration against the dev fixture; override via
// env to point at a different instance.
const ENDPOINT = process.env.PHOTO_STORAGE_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = process.env.PHOTO_STORAGE_S3_BUCKET ?? 'mercurio-test-photos';
const ACCESS_KEY_ID = process.env.PHOTO_STORAGE_S3_ACCESS_KEY_ID ?? 'mercurio';
const SECRET_ACCESS_KEY = process.env.PHOTO_STORAGE_S3_SECRET_ACCESS_KEY ?? 'mercurio-dev-secret';

/** Retries the bucket creation for a few seconds: MinIO takes a moment to
 *  accept connections right after `docker compose up`, and CI starts this
 *  suite immediately after bringing the container up. */
async function ensureBucket(client: S3Client): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      return;
    } catch (err) {
      if (err instanceof BucketAlreadyOwnedByYou) return;
      if (Date.now() > deadline) {
        throw new Error(
          `MinIO unreachable at ${ENDPOINT} (${err}). Start it first:\n` +
            '  docker compose -f infra/docker/docker-compose.yml up -d minio',
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

beforeAll(async () => {
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  });
  await ensureBucket(client);
});

runBlobStoreContractTests('s3 (MinIO)', () =>
  createS3BlobStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  }),
);
