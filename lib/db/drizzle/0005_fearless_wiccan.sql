CREATE TYPE "public"."notification_channel" AS ENUM('telegram', 'email', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."notification_event_type" AS ENUM('ALERT_CREATED', 'ALERT_ESCALATED', 'ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED', 'TEST');--> statement-breakpoint
CREATE TYPE "public"."notification_state" AS ENUM('PENDING', 'PROCESSING', 'SENT', 'RETRY', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "nexora_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization" text DEFAULT 'Default' NOT NULL,
	"alert_id" uuid,
	"alert_event_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"destination" text NOT NULL,
	"event_type" "notification_event_type" NOT NULL,
	"severity" "alert_severity",
	"state" "notification_state" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nexora_notifications_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "nexora_worker_heartbeats" (
	"worker" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "nexora_notifications" ADD CONSTRAINT "nexora_notifications_alert_id_nexora_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."nexora_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_notifications" ADD CONSTRAINT "nexora_notifications_alert_event_id_nexora_alert_events_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."nexora_alert_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nexora_notifications_claim_idx" ON "nexora_notifications" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "nexora_notifications_alert_idx" ON "nexora_notifications" USING btree ("alert_id","created_at");--> statement-breakpoint
CREATE INDEX "nexora_notifications_event_idx" ON "nexora_notifications" USING btree ("alert_event_id","channel");--> statement-breakpoint
CREATE INDEX "nexora_notifications_history_idx" ON "nexora_notifications" USING btree ("created_at","channel","state");--> statement-breakpoint
CREATE INDEX "nexora_notifications_lease_idx" ON "nexora_notifications" USING btree ("state","lease_until");