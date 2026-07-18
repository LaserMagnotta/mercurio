CREATE TYPE "public"."distance_metric" AS ENUM('haversine', 'road');--> statement-breakpoint
CREATE TABLE "road_distances" (
	"pair_key" text PRIMARY KEY NOT NULL,
	"metres" integer NOT NULL,
	"source" text DEFAULT 'osrm' NOT NULL,
	"data_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_geometries" (
	"pair_key" text PRIMARY KEY NOT NULL,
	"points" jsonb NOT NULL,
	"source" text DEFAULT 'osrm' NOT NULL,
	"data_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "distance_metric" "distance_metric" DEFAULT 'haversine' NOT NULL;