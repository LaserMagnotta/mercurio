-- Shipment codenames (Fase 1 punto 1): a human-sayable label minted
-- server-side at POST /shipments. NOT NULL with no default and UNIQUE: there
-- is no meaningful constant backfill (each codename must be unique and match
-- the Animal-Adjective-NNN shape). This runs against an EMPTY shipments table
-- in every real environment — production is a fresh deploy with no shipments
-- (ADR-024: "nessun dato demo, mai"), and dev migrates before seeding, where
-- the seed already supplies a codename.
ALTER TABLE "shipments" ADD COLUMN "codename" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_codename_unique" UNIQUE("codename");