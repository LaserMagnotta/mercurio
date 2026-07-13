CREATE TYPE "public"."escrow_intent_verb" AS ENUM('release', 'refund');--> statement-breakpoint
CREATE TYPE "public"."instant_payment_reason" AS ENUM('dep_hub_fee', 'arr_hub_fee', 'cancellation_compensation');--> statement-breakpoint
CREATE TYPE "public"."instant_payment_state" AS ENUM('created', 'settled');--> statement-breakpoint
CREATE TYPE "public"."shipment_timer_kind" AS ENUM('leg_funding', 'pickup', 'transit', 'storage');--> statement-breakpoint
CREATE TABLE "shipment_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" "shipment_timer_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instant_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"amount_msat" bigint NOT NULL,
	"reason" "instant_payment_reason" NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"bolt11" text,
	"payment_hash" text,
	"state" "instant_payment_state" DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "instant_payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "escrow_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"verb" "escrow_intent_verb" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "segment_work_msat" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "checkout_hub_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "checkout_carrier_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "checkout_photo_sha256" jsonb;--> statement-breakpoint
ALTER TABLE "shipment_timers" ADD CONSTRAINT "shipment_timers_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_payments" ADD CONSTRAINT "instant_payments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_payments" ADD CONSTRAINT "instant_payments_payer_id_users_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_payments" ADD CONSTRAINT "instant_payments_payee_id_users_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_intents" ADD CONSTRAINT "escrow_intents_payment_id_conditional_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_timers_kind_ref_idx" ON "shipment_timers" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_intents_payment_verb_idx" ON "escrow_intents" USING btree ("payment_id","verb");--> statement-breakpoint
-- Hand-added from here on (same rationale as 0001/0003).
-- Backfill: pre-ADR-014 rows never rerouted, so the current segment's work
-- pool is exactly the 90% split of the offer (splitCommitment, msat floor).
UPDATE "shipments" SET "segment_work_msat" = ("offer_msat" * 9000) / 10000 WHERE "segment_work_msat" = 0;--> statement-breakpoint
-- Money-shaped columns are >= 0 (CHECK at the database level, not only in code).
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_segment_work_nonneg" CHECK ("segment_work_msat" >= 0);--> statement-breakpoint
ALTER TABLE "instant_payments" ADD CONSTRAINT "instant_payments_amount_positive" CHECK ("amount_msat" > 0);--> statement-breakpoint
-- Hot lookup paths of the lifecycle executor and workers.
CREATE INDEX "conditional_payments_shipment_idx" ON "conditional_payments" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "custody_events_shipment_idx" ON "custody_events" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_timers_fire_at_idx" ON "shipment_timers" USING btree ("fire_at");--> statement-breakpoint
CREATE INDEX "email_outbox_status_idx" ON "email_outbox" USING btree ("status");