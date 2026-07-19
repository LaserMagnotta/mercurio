import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { photoKindEnum } from './enums.js';
import { hubs } from './hubs.js';

// Venue photos of a hub (ADR-028, Fase 2 punto 6): the shop/bar storefront a
// sender or carrier sees when choosing a hub. Unlike shipment `photos`, these
// are:
//   - tied to the HUB, not a shipment (no custody chain, no per-shipment authz);
//   - PUBLICLY readable (they help pick a counterparty — CLAUDE.md);
//   - permanent (no retention/purge — they live and die with the hub row).
// They therefore live in their OWN table and their OWN blob store: the shipment
// photo purge worker's orphan sweep (ADR-020 §5) deletes any blob with no
// `photos` row, which would eat every venue blob if the two shared a store.
// Everything else is reused: the content-addressed BlobStore interface, the
// on-device EXIF strip + re-encode, and the server-side JPEG/GPS validation.
export const hubPhotos = pgTable(
  'hub_photos',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => hubs.id),
    // Always 'hub_venue' today; the column keeps one shared photo vocabulary and
    // leaves room for future venue-photo subkinds without another enum.
    kind: photoKindEnum('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Re-uploading the same bytes for the same hub is an idempotent no-op.
  (t) => [unique('hub_photos_hub_sha_unique').on(t.hubId, t.sha256)],
);
