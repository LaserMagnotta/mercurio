ALTER TYPE "public"."photo_kind" ADD VALUE 'hub_venue';--> statement-breakpoint
CREATE TABLE "hub_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hub_id" uuid NOT NULL,
	"kind" "photo_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_photos_hub_sha_unique" UNIQUE("hub_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "hub_photos" ADD CONSTRAINT "hub_photos_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;