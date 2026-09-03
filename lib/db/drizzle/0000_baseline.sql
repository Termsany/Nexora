DO $$ BEGIN
 CREATE TYPE "public"."device_status" AS ENUM('ONLINE', 'OFFLINE', 'UNKNOWN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexora_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"event" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexora_agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "nexora_agent_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexora_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"device_uuid" uuid NOT NULL,
	"hostname" text NOT NULL,
	"status" "device_status" DEFAULT 'UNKNOWN' NOT NULL,
	"current_user" text,
	"domain" text,
	"os_name" text,
	"os_version" text,
	"os_build" text,
	"architecture" text,
	"ip_address" text,
	"agent_version" text,
	"machine_guid_hash" text,
	"last_seen_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hardware" jsonb,
	"disks" jsonb,
	"network" jsonb,
	CONSTRAINT "nexora_devices_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "nexora_devices_device_uuid_unique" UNIQUE("device_uuid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexora_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nexora_enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexora_device_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" double precision NOT NULL,
	"ram_percent" double precision NOT NULL,
	"ram_used_bytes" integer NOT NULL,
	"ram_available_bytes" integer NOT NULL,
	"disk_percent" double precision NOT NULL,
	"uptime_seconds" integer NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nexora_activity" ADD CONSTRAINT "nexora_activity_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nexora_agent_credentials" ADD CONSTRAINT "nexora_agent_credentials_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nexora_device_metrics" ADD CONSTRAINT "nexora_device_metrics_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
