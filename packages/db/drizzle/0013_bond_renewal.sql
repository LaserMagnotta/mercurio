ALTER TYPE "public"."custody_event_type" ADD VALUE 'bond_renewed';--> statement-breakpoint
ALTER TYPE "public"."shipment_timer_kind" ADD VALUE 'bond_renewal';--> statement-breakpoint
ALTER TABLE "hub_stays" ADD COLUMN "bond_window_ends_at" timestamp with time zone;