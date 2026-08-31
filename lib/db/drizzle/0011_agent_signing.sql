CREATE TYPE "public"."agent_signing_key_status" AS ENUM('ACTIVE','REVOKED','REPLACED');--> statement-breakpoint
CREATE TABLE "nexora_agent_signing_keys" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "device_id" uuid NOT NULL REFERENCES "nexora_devices"("id") ON DELETE CASCADE, "algorithm" text NOT NULL, "public_key" text NOT NULL, "key_fingerprint" text NOT NULL, "protocol_version" text NOT NULL DEFAULT 'remote_command_v1', "status" "agent_signing_key_status" NOT NULL DEFAULT 'ACTIVE', "created_at" timestamptz NOT NULL DEFAULT now(), "activated_at" timestamptz NOT NULL DEFAULT now(), "revoked_at" timestamptz, "replaced_by" uuid
);--> statement-breakpoint
CREATE INDEX "nexora_agent_signing_keys_device_idx" ON "nexora_agent_signing_keys" ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_agent_signing_keys_active_device_idx" ON "nexora_agent_signing_keys" ("device_id","status");
