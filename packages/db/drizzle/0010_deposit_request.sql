ALTER TYPE "public"."custody_event_type" ADD VALUE 'deposit_requested';--> statement-breakpoint
ALTER TYPE "public"."leg_status" ADD VALUE 'requested';--> statement-breakpoint
ALTER TYPE "public"."rejection_stage" ADD VALUE 'deposit_request';--> statement-breakpoint
ALTER TYPE "public"."shipment_timer_kind" ADD VALUE 'deposit_response';--> statement-breakpoint
ALTER TABLE "hubs" ALTER COLUMN "auto_accept" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "legs" ALTER COLUMN "funding_deadline_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "response_deadline_at" timestamp with time zone;