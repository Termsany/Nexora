CREATE TYPE "public"."remote_command_status" AS ENUM('PENDING','READY','CLAIMED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCEL_REQUESTED','CANCELLED','EXPIRED','UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."remote_command_shell" AS ENUM('CMD','POWERSHELL');--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "remote_commands_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE TABLE "nexora_remote_command_jobs" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "nexora_organizations"("id"), "device_id" uuid NOT NULL REFERENCES "nexora_devices"("id"), "privileged_action_id" uuid NOT NULL UNIQUE REFERENCES "nexora_privileged_actions"("id"), "status" "remote_command_status" NOT NULL DEFAULT 'PENDING', "shell_type" "remote_command_shell" NOT NULL, "command_payload" jsonb NOT NULL, "working_directory" text, "timeout_seconds" integer NOT NULL DEFAULT 60, "requested_by_user_id" uuid NOT NULL REFERENCES "nexora_users"("id"), "approved_by_user_id" uuid REFERENCES "nexora_users"("id"), "created_at" timestamptz NOT NULL DEFAULT now(), "ready_at" timestamptz, "claimed_at" timestamptz, "started_at" timestamptz, "completed_at" timestamptz, "expires_at" timestamptz NOT NULL, "lease_expires_at" timestamptz, "last_execution_heartbeat_at" timestamptz, "execution_id" uuid, "execution_attempt" integer NOT NULL DEFAULT 0, "exit_code" integer, "stdout" text, "stderr" text, "stdout_truncated" boolean NOT NULL DEFAULT false, "stderr_truncated" boolean NOT NULL DEFAULT false, "failure_code" text, "failure_message" text, "cancel_requested_at" timestamptz, "created_request_id" text, "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "nexora_remote_command_jobs" ADD COLUMN "execution_capability_hash" text;--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_org_idx" ON "nexora_remote_command_jobs" ("organization_id");--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_device_idx" ON "nexora_remote_command_jobs" ("device_id");--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_status_idx" ON "nexora_remote_command_jobs" ("status");--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_created_idx" ON "nexora_remote_command_jobs" ("created_at");--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_expiry_idx" ON "nexora_remote_command_jobs" ("expires_at");--> statement-breakpoint
CREATE INDEX "nexora_remote_commands_lease_idx" ON "nexora_remote_command_jobs" ("lease_expires_at");
