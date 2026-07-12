ALTER TABLE "conditional_payments" ADD COLUMN "shipment_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conditional_payments" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditional_payments" ADD CONSTRAINT "conditional_payments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditional_payments" ADD CONSTRAINT "conditional_payments_idempotency_key_unique" UNIQUE("idempotency_key");