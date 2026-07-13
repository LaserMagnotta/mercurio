ALTER TYPE "public"."conditional_payment_purpose" ADD VALUE 'finalization_bonus';--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "finalization_bonus_msat" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-added (same rationale as 0001): money-shaped domain columns are >= 0.
ALTER TABLE "legs" ADD CONSTRAINT "legs_finalization_bonus_nonneg" CHECK ("finalization_bonus_msat" >= 0);
