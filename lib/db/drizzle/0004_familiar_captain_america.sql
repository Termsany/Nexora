CREATE TYPE "public"."alert_event_type" AS ENUM('CREATED', 'SEVERITY_CHANGED', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_state" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('DEVICE_OFFLINE', 'CPU_HIGH', 'MEMORY_HIGH', 'DISK_HIGH');--> statement-breakpoint
CREATE TABLE "nexora_alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"event_type" "alert_event_type" NOT NULL,
	"previous_state" "alert_state",
	"new_state" "alert_state",
	"previous_severity" "alert_severity",
	"new_severity" "alert_severity",
	"actor" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "nexora_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization" text DEFAULT 'Default' NOT NULL,
	"device_id" uuid NOT NULL,
	"type" "alert_type" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"state" "alert_state" DEFAULT 'OPEN' NOT NULL,
	"resource" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"acknowledged_by" text,
	"trigger_value" double precision,
	"threshold_value" double precision,
	"dedup_key" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "organization" text DEFAULT 'Default' NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_alert_events" ADD CONSTRAINT "nexora_alert_events_alert_id_nexora_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."nexora_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_alerts" ADD CONSTRAINT "nexora_alerts_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nexora_alert_events_alert_timestamp_idx" ON "nexora_alert_events" USING btree ("alert_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_alerts_active_dedup_uidx" ON "nexora_alerts" USING btree ("dedup_key") WHERE "nexora_alerts"."state" IN ('OPEN', 'ACKNOWLEDGED');--> statement-breakpoint
CREATE INDEX "nexora_alerts_list_idx" ON "nexora_alerts" USING btree ("state","severity","last_triggered_at");--> statement-breakpoint
CREATE INDEX "nexora_alerts_device_idx" ON "nexora_alerts" USING btree ("device_id","state","last_triggered_at");--> statement-breakpoint
CREATE INDEX "nexora_alerts_organization_idx" ON "nexora_alerts" USING btree ("organization","state","last_triggered_at");