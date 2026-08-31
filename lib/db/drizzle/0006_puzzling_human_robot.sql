CREATE TYPE "public"."software_architecture" AS ENUM('x64', 'x86', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."software_change_type" AS ENUM('INSTALLED', 'REMOVED', 'VERSION_CHANGED');--> statement-breakpoint
CREATE TABLE "nexora_device_software" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"software_identity" text NOT NULL,
	"normalized_name" text NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"publisher" text,
	"architecture" "software_architecture" DEFAULT 'unknown' NOT NULL,
	"install_date" timestamp with time zone,
	"install_location" text,
	"product_code" text,
	"source" text DEFAULT 'windows_registry' NOT NULL,
	"system_component" boolean DEFAULT false NOT NULL,
	"uninstall_available" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_present" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_software_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"software_identity" text NOT NULL,
	"change_type" "software_change_type" NOT NULL,
	"name" text NOT NULL,
	"publisher" text,
	"previous_version" text,
	"current_version" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "software_inventory_initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nexora_device_software" ADD CONSTRAINT "nexora_device_software_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_software_changes" ADD CONSTRAINT "nexora_software_changes_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_device_software_identity_uidx" ON "nexora_device_software" USING btree ("device_id","software_identity");--> statement-breakpoint
CREATE INDEX "nexora_device_software_present_idx" ON "nexora_device_software" USING btree ("device_id","is_present","normalized_name");--> statement-breakpoint
CREATE INDEX "nexora_software_fleet_idx" ON "nexora_device_software" USING btree ("software_identity","is_present","last_seen_at");--> statement-breakpoint
CREATE INDEX "nexora_software_name_idx" ON "nexora_device_software" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "nexora_software_publisher_idx" ON "nexora_device_software" USING btree ("publisher");--> statement-breakpoint
CREATE INDEX "nexora_software_changes_device_time_idx" ON "nexora_software_changes" USING btree ("device_id","observed_at");--> statement-breakpoint
CREATE INDEX "nexora_software_changes_identity_time_idx" ON "nexora_software_changes" USING btree ("software_identity","observed_at");--> statement-breakpoint
CREATE INDEX "nexora_software_changes_retention_idx" ON "nexora_software_changes" USING btree ("observed_at");