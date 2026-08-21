CREATE TABLE "nexora_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"subject_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexora_device_metrics" ALTER COLUMN "ram_used_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "nexora_device_metrics" ALTER COLUMN "ram_available_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD COLUMN "organization" text DEFAULT 'Default' NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "nexora_devices_last_seen_idx" ON "nexora_devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "nexora_metrics_device_received_idx" ON "nexora_device_metrics" USING btree ("device_id","received_at");