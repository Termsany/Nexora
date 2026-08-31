CREATE TYPE "public"."inventory_collection_status" AS ENUM('COMPLETE', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."process_architecture" AS ENUM('x64', 'x86', 'arm64', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."service_event_type" AS ENUM('STATUS_CHANGED', 'STARTUP_TYPE_CHANGED', 'SERVICE_ADDED', 'SERVICE_REMOVED');--> statement-breakpoint
CREATE TYPE "public"."service_startup_type" AS ENUM('AUTOMATIC', 'AUTOMATIC_DELAYED', 'MANUAL', 'DISABLED', 'BOOT', 'SYSTEM', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('RUNNING', 'STOPPED', 'PAUSED', 'START_PENDING', 'STOP_PENDING', 'PAUSE_PENDING', 'CONTINUE_PENDING', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "nexora_device_processes_current" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"pid" integer NOT NULL,
	"process_name" text NOT NULL,
	"executable_path" text,
	"username" text,
	"cpu_time_seconds" double precision NOT NULL,
	"cpu_percent" double precision,
	"working_set_bytes" bigint NOT NULL,
	"private_memory_bytes" bigint,
	"thread_count" integer,
	"handle_count" integer,
	"started_at" timestamp with time zone NOT NULL,
	"architecture" "process_architecture" NOT NULL,
	"session_id" integer,
	"snapshot_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_device_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "service_status" NOT NULL,
	"startup_type" "service_startup_type" NOT NULL,
	"logon_as" text,
	"service_type" text,
	"process_id" integer,
	"binary_path" text,
	"description" text,
	"delayed_auto_start" boolean,
	"is_present" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"inventory_type" text NOT NULL,
	"collection_status" "inventory_collection_status" NOT NULL,
	"item_count" integer NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"agent_version" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_service_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"event_type" "service_event_type" NOT NULL,
	"previous_value" text,
	"new_value" text,
	"observed_at" timestamp with time zone NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "services_inventory_initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "services_last_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "processes_last_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nexora_device_processes_current" ADD CONSTRAINT "nexora_device_processes_current_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_device_services" ADD CONSTRAINT "nexora_device_services_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_inventory_snapshots" ADD CONSTRAINT "nexora_inventory_snapshots_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_service_events" ADD CONSTRAINT "nexora_service_events_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_device_processes_identity_uidx" ON "nexora_device_processes_current" USING btree ("device_id","pid","started_at");--> statement-breakpoint
CREATE INDEX "nexora_device_processes_name_idx" ON "nexora_device_processes_current" USING btree ("device_id","process_name");--> statement-breakpoint
CREATE INDEX "nexora_device_processes_cpu_idx" ON "nexora_device_processes_current" USING btree ("device_id","cpu_percent");--> statement-breakpoint
CREATE INDEX "nexora_device_processes_memory_idx" ON "nexora_device_processes_current" USING btree ("device_id","working_set_bytes");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_device_services_identity_uidx" ON "nexora_device_services" USING btree ("device_id","service_name");--> statement-breakpoint
CREATE INDEX "nexora_device_services_device_status_idx" ON "nexora_device_services" USING btree ("device_id","is_present","status");--> statement-breakpoint
CREATE INDEX "nexora_device_services_startup_idx" ON "nexora_device_services" USING btree ("startup_type","is_present");--> statement-breakpoint
CREATE INDEX "nexora_device_services_last_seen_idx" ON "nexora_device_services" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_inventory_snapshots_device_type_id_uidx" ON "nexora_inventory_snapshots" USING btree ("device_id","inventory_type","snapshot_id");--> statement-breakpoint
CREATE INDEX "nexora_inventory_snapshots_retention_idx" ON "nexora_inventory_snapshots" USING btree ("inventory_type","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_service_events_snapshot_event_uidx" ON "nexora_service_events" USING btree ("device_id","snapshot_id","service_name","event_type");--> statement-breakpoint
CREATE INDEX "nexora_service_events_device_time_idx" ON "nexora_service_events" USING btree ("device_id","observed_at");