CREATE TYPE "public"."shipment_claim_status" AS ENUM('pending_funding', 'funded', 'completed', 'expired');--> statement-breakpoint
ALTER TYPE "public"."conditional_payment_purpose" ADD VALUE 'claim_payment';--> statement-breakpoint
ALTER TYPE "public"."conditional_payment_ref_type" ADD VALUE 'claim';--> statement-breakpoint
ALTER TYPE "public"."custody_event_type" ADD VALUE 'claim_requested';--> statement-breakpoint
ALTER TYPE "public"."custody_event_type" ADD VALUE 'recipient_claimed';--> statement-breakpoint
ALTER TYPE "public"."shipment_status" ADD VALUE 'claimed';--> statement-breakpoint
ALTER TYPE "public"."shipment_timer_kind" ADD VALUE 'claim_funding';--> statement-breakpoint
CREATE TABLE "shipment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"claimant_id" uuid NOT NULL,
	"hub_stay_id" uuid NOT NULL,
	"claim_payment_msat" bigint NOT NULL,
	"hub_bonus_msat" bigint NOT NULL,
	"payment_cp_id" uuid,
	"hub_bonus_cp_id" uuid,
	"status" "shipment_claim_status" DEFAULT 'pending_funding' NOT NULL,
	"funding_deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "recipient_claim_token_hash" text;--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_claimant_id_users_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_hub_stay_id_hub_stays_id_fk" FOREIGN KEY ("hub_stay_id") REFERENCES "public"."hub_stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_payment_cp_id_conditional_payments_id_fk" FOREIGN KEY ("payment_cp_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_hub_bonus_cp_id_conditional_payments_id_fk" FOREIGN KEY ("hub_bonus_cp_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-added from here on (same rationale as 0001/0003/0004).
-- Money-shaped columns respect their protocol bounds at the database level:
-- a zero-amount hold cannot exist on Lightning (ADR-016 rejects the claim),
-- while a zero hub bonus simply means no second hold was created.
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_payment_positive" CHECK ("claim_payment_msat" > 0);--> statement-breakpoint
ALTER TABLE "shipment_claims" ADD CONSTRAINT "shipment_claims_hub_bonus_nonneg" CHECK ("hub_bonus_msat" >= 0);--> statement-breakpoint
-- At most ONE live claim per shipment (the machine's guard, backed by the DB).
CREATE UNIQUE INDEX "shipment_claims_one_live_per_shipment_idx" ON "shipment_claims" ("shipment_id") WHERE "status" IN ('pending_funding', 'funded');--> statement-breakpoint
-- Hot lookup path of the context builder and the wallet pump.
CREATE INDEX "shipment_claims_shipment_idx" ON "shipment_claims" USING btree ("shipment_id");