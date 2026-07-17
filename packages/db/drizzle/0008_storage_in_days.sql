-- Storage window moves from hours to DAYS (ADR-026 Parte 1). The column is
-- renamed AND its existing values converted: an old value is in hours, the new
-- column means days, so `ceil(hours / 24)` — rounding UP so no already-accepted
-- window is silently shortened (same rule as ARCHITECTURE §5 prec. 9). The cap
-- stays 7 days (MAX_STORAGE_DAYS); ADR-026 Parte 2 raises it to 30 once the
-- hub bond renews rolling, a change to the escrow, not a migration here.
ALTER TABLE "shipments" RENAME COLUMN "max_storage_hours" TO "max_storage_days";--> statement-breakpoint
UPDATE "shipments" SET "max_storage_days" = CEIL("max_storage_days"::numeric / 24)::integer;--> statement-breakpoint
ALTER TABLE "hubs" RENAME COLUMN "max_storage_hours" TO "max_storage_days";--> statement-breakpoint
UPDATE "hubs" SET "max_storage_days" = CEIL("max_storage_days"::numeric / 24)::integer;
