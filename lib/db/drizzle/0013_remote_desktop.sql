-- Remote Desktop V1.
--
-- Forward-only. Replaces an earlier WebRTC signalling sketch that was never
-- applied to any environment: that design needed a WebRTC stack in the Agent
-- and let peers negotiate a path Nexora could not authorise or audit. V1 is
-- mediated - browser and Agent each hold an authenticated WebSocket to Nexora.
--
-- ALTER TYPE ... ADD VALUE is safe inside this transaction on PostgreSQL 12+
-- because the new label is not used by any statement in this migration; the
-- first use is at runtime, in a later transaction.
ALTER TYPE "public"."privileged_action_type" ADD VALUE IF NOT EXISTS 'REMOTE_DESKTOP';--> statement-breakpoint

CREATE TYPE "public"."remote_desktop_session_status" AS ENUM('REQUESTED','AUTHORIZED','CONNECTING','CONNECTED','ACTIVE','DISCONNECTING','CLOSED','EXPIRED','FAILED');--> statement-breakpoint

-- Device-level capability switch. Default false: Remote Desktop is never
-- silently available on a device that was not explicitly opted in.
ALTER TABLE "nexora_devices" ADD COLUMN IF NOT EXISTS "remote_desktop_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "nexora_remote_desktop_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "nexora_organizations"("id") ON DELETE RESTRICT,
  "site_id" uuid REFERENCES "nexora_sites"("id") ON DELETE RESTRICT,
  "device_id" uuid NOT NULL REFERENCES "nexora_devices"("id") ON DELETE RESTRICT,
  "privileged_action_id" uuid NOT NULL UNIQUE REFERENCES "nexora_privileged_actions"("id") ON DELETE RESTRICT,
  "status" "remote_desktop_session_status" DEFAULT 'REQUESTED' NOT NULL,
  -- SHA-256 hashes only; raw tokens are returned once and never stored.
  "viewer_token_hash" text NOT NULL,
  -- Null until the Agent claims; minted at hand-out, never stored recoverably.
  "agent_token_hash" text,
  "requested_by_user_id" uuid NOT NULL REFERENCES "nexora_users"("id") ON DELETE RESTRICT,
  "approved_by_user_id" uuid REFERENCES "nexora_users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "authorized_at" timestamptz,
  "viewer_connected_at" timestamptz,
  "agent_connected_at" timestamptz,
  "started_at" timestamptz,
  "last_activity_at" timestamptz,
  "closed_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "close_reason" text,
  "screen_width" integer,
  "screen_height" integer,
  "frames_sent" integer DEFAULT 0 NOT NULL,
  "input_events_sent" integer DEFAULT 0 NOT NULL,
  "clipboard_enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "nexora_remote_desktop_sessions_org_idx" ON "nexora_remote_desktop_sessions" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "nexora_remote_desktop_sessions_device_idx" ON "nexora_remote_desktop_sessions" ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "nexora_remote_desktop_sessions_status_idx" ON "nexora_remote_desktop_sessions" ("status");--> statement-breakpoint
CREATE INDEX "nexora_remote_desktop_sessions_expiry_idx" ON "nexora_remote_desktop_sessions" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_remote_desktop_sessions_action_unique" ON "nexora_remote_desktop_sessions" ("privileged_action_id");--> statement-breakpoint

-- V1 concurrency policy enforced by the database, not by an application race:
-- at most one live session per device.
CREATE UNIQUE INDEX "nexora_remote_desktop_sessions_one_live_per_device"
  ON "nexora_remote_desktop_sessions" ("device_id")
  WHERE "status" IN ('REQUESTED','AUTHORIZED','CONNECTING','CONNECTED','ACTIVE','DISCONNECTING');
