CREATE TYPE "public"."account_kind" AS ENUM('external_wallet', 'commitment');--> statement-breakpoint
CREATE TYPE "public"."account_owner_type" AS ENUM('user', 'shipment');--> statement-breakpoint
CREATE TYPE "public"."auth_method" AS ENUM('magic_link', 'lnurl');--> statement-breakpoint
CREATE TYPE "public"."carrier_trip_status" AS ENUM('active', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."conditional_payment_purpose" AS ENUM('leg_payment', 'custody_bond');--> statement-breakpoint
CREATE TYPE "public"."conditional_payment_ref_type" AS ENUM('leg', 'hub_stay');--> statement-breakpoint
CREATE TYPE "public"."conditional_payment_state" AS ENUM('created', 'held', 'settled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('tos', 'privacy_policy');--> statement-breakpoint
CREATE TYPE "public"."custody_event_type" AS ENUM('created', 'funded', 'hub_checkin', 'leg_accepted', 'hub_checkout', 'hub_checkin_intermediate', 'leg_returned', 'arrived_destination', 'recipient_pickup', 'handoff_rejected', 'rerouted', 'boosted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hub_stay_status" AS ENUM('reserved', 'active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."leg_status" AS ENUM('pending_funding', 'booked', 'picked_up', 'completed', 'returned', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."photo_kind" AS ENUM('content', 'sealed', 'checkin', 'checkout', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."rejection_stage" AS ENUM('hub_checkin', 'pickup_checkout', 'recipient_pickup');--> statement-breakpoint
CREATE TYPE "public"."review_role" AS ENUM('sender', 'carrier', 'hub');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('draft', 'awaiting_dropoff', 'at_hub', 'leg_booked', 'in_transit', 'awaiting_pickup', 'delivered', 'cancelled', 'forfeited', 'lost');--> statement-breakpoint
CREATE TYPE "public"."wallet_kind" AS ENUM('nwc', 'lnd_rest', 'fake');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TABLE "carrier_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text DEFAULT 'it' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"method" "auth_method" DEFAULT 'magic_link' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "hubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"opening_hours" jsonb NOT NULL,
	"max_dim_cm_l" integer NOT NULL,
	"max_dim_cm_w" integer NOT NULL,
	"max_dim_cm_h" integer NOT NULL,
	"max_weight_g" integer NOT NULL,
	"accepts_undeclared" boolean DEFAULT false NOT NULL,
	"fee_percent" numeric(5, 2) NOT NULL,
	"max_storage_hours" integer NOT NULL,
	"auto_accept" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "hubs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "wallet_kind" NOT NULL,
	"connection_secret_encrypted" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" "wallet_status" DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"origin_lat" double precision NOT NULL,
	"origin_lng" double precision NOT NULL,
	"dest_lat" double precision NOT NULL,
	"dest_lng" double precision NOT NULL,
	"departs_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_deviation_km" double precision NOT NULL,
	"min_rate_msat_per_km" bigint NOT NULL,
	"status" "carrier_trip_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"origin_hub_id" uuid NOT NULL,
	"dest_hub_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_pickup_otp_hash" text,
	"qr_token" text NOT NULL,
	"dim_l_cm" integer NOT NULL,
	"dim_w_cm" integer NOT NULL,
	"dim_h_cm" integer NOT NULL,
	"weight_g" integer NOT NULL,
	"declared_content" text,
	"undeclared" boolean DEFAULT false NOT NULL,
	"offer_msat" bigint NOT NULL,
	"custody_bond_msat" bigint NOT NULL,
	"max_storage_hours" integer NOT NULL,
	"eur_rate_snapshot" numeric(18, 8) NOT NULL,
	"eur_rate_source" text NOT NULL,
	"eur_rate_at" timestamp with time zone NOT NULL,
	"status" "shipment_status" DEFAULT 'draft' NOT NULL,
	"distance_km" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_qr_token_unique" UNIQUE("qr_token")
);
--> statement-breakpoint
CREATE TABLE "conditional_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"amount_msat" bigint NOT NULL,
	"purpose" "conditional_payment_purpose" NOT NULL,
	"ref_type" "conditional_payment_ref_type" NOT NULL,
	"ref_id" uuid NOT NULL,
	"payment_hash" text NOT NULL,
	"preimage_encrypted" text,
	"bolt11" text,
	"state" "conditional_payment_state" DEFAULT 'created' NOT NULL,
	"hold_window_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "conditional_payments_payment_hash_unique" UNIQUE("payment_hash")
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"carrier_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_hub_id" uuid NOT NULL,
	"to_hub_id" uuid NOT NULL,
	"status" "leg_status" DEFAULT 'pending_funding' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"funding_deadline_at" timestamp with time zone NOT NULL,
	"pickup_deadline_at" timestamp with time zone,
	"transit_deadline_at" timestamp with time zone,
	"progress_km" double precision NOT NULL,
	"gross_msat" bigint NOT NULL,
	"dep_hub_fee_msat" bigint NOT NULL,
	"arr_hub_fee_msat" bigint NOT NULL,
	"net_msat" bigint NOT NULL,
	"payment_cp_id" uuid,
	"bond_cp_id" uuid
);
--> statement-breakpoint
CREATE TABLE "hub_stays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"hub_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" "hub_stay_status" DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"storage_deadline_at" timestamp with time zone,
	"bond_cp_id" uuid
);
--> statement-breakpoint
CREATE TABLE "custody_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"type" "custody_event_type" NOT NULL,
	"actor_user_id" uuid,
	"leg_id" uuid,
	"hub_stay_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_event_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"leg_id" uuid,
	"hub_stay_id" uuid,
	"rejected_by" uuid NOT NULL,
	"stage" "rejection_stage" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"custody_event_id" uuid,
	"rejection_id" uuid,
	"kind" "photo_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"taken_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "account_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "account_kind" NOT NULL,
	"currency" text DEFAULT 'msat' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_msat" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"role" "review_role" NOT NULL,
	"stars" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_shipment_author_subject_role_key" UNIQUE("shipment_id","author_id","subject_id","role")
);
--> statement-breakpoint
CREATE TABLE "rate_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leg_id" uuid NOT NULL,
	"detour_km" double precision NOT NULL,
	"net_msat" bigint NOT NULL,
	"eur_rate" numeric(18, 8) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "carrier_profiles" ADD CONSTRAINT "carrier_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_connections" ADD CONSTRAINT "wallet_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_trips" ADD CONSTRAINT "carrier_trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_hub_id_hubs_id_fk" FOREIGN KEY ("origin_hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dest_hub_id_hubs_id_fk" FOREIGN KEY ("dest_hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditional_payments" ADD CONSTRAINT "conditional_payments_payer_id_users_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditional_payments" ADD CONSTRAINT "conditional_payments_payee_id_users_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_carrier_id_users_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_trip_id_carrier_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."carrier_trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_from_hub_id_hubs_id_fk" FOREIGN KEY ("from_hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_to_hub_id_hubs_id_fk" FOREIGN KEY ("to_hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_payment_cp_id_conditional_payments_id_fk" FOREIGN KEY ("payment_cp_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_bond_cp_id_conditional_payments_id_fk" FOREIGN KEY ("bond_cp_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_stays" ADD CONSTRAINT "hub_stays_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_stays" ADD CONSTRAINT "hub_stays_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_stays" ADD CONSTRAINT "hub_stays_bond_cp_id_conditional_payments_id_fk" FOREIGN KEY ("bond_cp_id") REFERENCES "public"."conditional_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_hub_stay_id_hub_stays_id_fk" FOREIGN KEY ("hub_stay_id") REFERENCES "public"."hub_stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_hub_stay_id_hub_stays_id_fk" FOREIGN KEY ("hub_stay_id") REFERENCES "public"."hub_stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_custody_event_id_custody_events_id_fk" FOREIGN KEY ("custody_event_id") REFERENCES "public"."custody_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_rejection_id_rejections_id_fk" FOREIGN KEY ("rejection_id") REFERENCES "public"."rejections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_observations" ADD CONSTRAINT "rate_observations_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "postings_journal_entry_id_idx" ON "postings" USING btree ("journal_entry_id");