CREATE TYPE "public"."privileged_action_status" AS ENUM('PENDING_APPROVAL','APPROVED','REJECTED','EXPIRED','CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."privileged_action_type" AS ENUM('REMOTE_COMMAND','REMOTE_POWERSHELL','SERVICE_START','SERVICE_STOP','SERVICE_RESTART','PROCESS_TERMINATE','SOFTWARE_INSTALL','SOFTWARE_UNINSTALL','PATCH_INSTALL');--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "actor_type" text DEFAULT 'SYSTEM' NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "actor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "result" text DEFAULT 'SUCCESS' NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD CONSTRAINT "nexora_audit_log_actor_agent_id_nexora_devices_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."nexora_devices"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "nexora_audit_log_action_idx" ON "nexora_audit_log" ("action","created_at");--> statement-breakpoint
CREATE INDEX "nexora_audit_log_request_idx" ON "nexora_audit_log" ("request_id");--> statement-breakpoint
CREATE TABLE "nexora_privileged_actions" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "organization_id" uuid NOT NULL,
 "device_id" uuid,
 "action_type" "privileged_action_type" NOT NULL,
 "status" "privileged_action_status" DEFAULT 'PENDING_APPROVAL' NOT NULL,
 "requested_by" uuid NOT NULL,
 "requested_at" timestamptz DEFAULT now() NOT NULL,
 "approved_by" uuid,
 "approved_at" timestamptz,
 "rejected_by" uuid,
 "rejected_at" timestamptz,
 "expires_at" timestamptz NOT NULL,
 "request_reason" text NOT NULL,
 "safe_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "requires_two_person" boolean DEFAULT true NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "nexora_privileged_actions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "nexora_organizations"("id") ON DELETE restrict,
 CONSTRAINT "nexora_privileged_actions_device_fk" FOREIGN KEY ("device_id") REFERENCES "nexora_devices"("id") ON DELETE restrict,
 CONSTRAINT "nexora_privileged_actions_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "nexora_users"("id") ON DELETE restrict,
 CONSTRAINT "nexora_privileged_actions_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "nexora_users"("id") ON DELETE restrict,
 CONSTRAINT "nexora_privileged_actions_rejected_by_fk" FOREIGN KEY ("rejected_by") REFERENCES "nexora_users"("id") ON DELETE restrict,
 CONSTRAINT "nexora_privileged_actions_state_ck" CHECK (
   (status='PENDING_APPROVAL' AND approved_at IS NULL AND rejected_at IS NULL) OR
   (status='APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND rejected_at IS NULL) OR
   (status='REJECTED' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND approved_at IS NULL) OR
   status IN ('EXPIRED','CANCELLED')
 )
);--> statement-breakpoint
CREATE INDEX "nexora_privileged_actions_org_status_idx" ON "nexora_privileged_actions" ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "nexora_privileged_actions_device_idx" ON "nexora_privileged_actions" ("device_id","created_at");
