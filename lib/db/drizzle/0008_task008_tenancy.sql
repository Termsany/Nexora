-- Task #008 — multi-tenant organizations, sites and tenant isolation.
--
-- Hand-staged from the drizzle-kit diff. The generated form added
-- `organization_id ... NOT NULL` straight onto nexora_devices, nexora_alerts
-- and nexora_enrollment_tokens, which cannot succeed against a populated
-- database. This file instead follows the order required by Task #008 §E:
-- create the tenant tables, seed organizations from the existing free-text
-- labels, add the columns nullable, backfill, assert that nothing is orphaned,
-- and only then enforce NOT NULL and the foreign keys.
--
-- drizzle-orm's migrator wraps each migration file in a single transaction, so
-- any failure below — including the deliberate orphan assertions — rolls the
-- whole migration back and leaves the database untouched.
--
-- Existing device identity, agent credentials, telemetry, alerts, notification
-- history and software history are preserved. No row is deleted.

CREATE TYPE "public"."organization_role" AS ENUM('ORGANIZATION_ADMIN', 'ORGANIZATION_TECHNICIAN', 'ORGANIZATION_VIEWER');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('ACTIVE', 'SUSPENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('PLATFORM_SUPER_ADMIN', 'PLATFORM_ADMIN', 'PLATFORM_TECHNICIAN');--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."user_scope" AS ENUM('PLATFORM', 'ORGANIZATION');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint

CREATE TABLE "nexora_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "organization_status" DEFAULT 'ACTIVE' NOT NULL,
	"external_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "nexora_organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "nexora_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"address" text,
	"city" text,
	"country" text,
	"timezone" text,
	"status" "site_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "nexora_sites_id_organization_uk" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "nexora_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"scope" "user_scope" NOT NULL,
	"platform_role" "platform_role",
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nexora_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "nexora_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "nexora_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "nexora_organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" "organization_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "nexora_sites" ADD CONSTRAINT "nexora_sites_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_sessions" ADD CONSTRAINT "nexora_sessions_user_id_nexora_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nexora_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_organization_memberships" ADD CONSTRAINT "nexora_organization_memberships_user_id_nexora_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nexora_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_organization_memberships" ADD CONSTRAINT "nexora_organization_memberships_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- A platform role is meaningful only for a platform-scoped user. Enforcing the
-- pairing here means an organization user can never be given one, whatever the
-- application layer does.
ALTER TABLE "nexora_users" ADD CONSTRAINT "nexora_users_scope_role_ck" CHECK (
	("scope" = 'PLATFORM' AND "platform_role" IS NOT NULL) OR
	("scope" = 'ORGANIZATION' AND "platform_role" IS NULL)
);--> statement-breakpoint

CREATE INDEX "nexora_organizations_status_idx" ON "nexora_organizations" USING btree ("status","name");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_sites_organization_name_uidx" ON "nexora_sites" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "nexora_sites_organization_idx" ON "nexora_sites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "nexora_sites_organization_status_idx" ON "nexora_sites" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "nexora_users_scope_idx" ON "nexora_users" USING btree ("scope","status");--> statement-breakpoint
CREATE INDEX "nexora_sessions_user_idx" ON "nexora_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "nexora_sessions_expiry_idx" ON "nexora_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_organization_memberships_user_org_uidx" ON "nexora_organization_memberships" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "nexora_organization_memberships_organization_idx" ON "nexora_organization_memberships" USING btree ("organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seed organizations from the pre-existing free-text `organization` labels.
--
-- Every distinct label, compared case-insensitively and trimmed, becomes one
-- organization. The legacy label "Default" (and any blank label) is folded into
-- "Internal / Pilot"; every other label keeps its own organization so groupings
-- that already existed in the deployment survive the migration.
-- ---------------------------------------------------------------------------

CREATE TABLE "nexora_task008_org_map" (
	"legacy_key" text PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint

-- Canonical spelling per case-folded label: whichever casing appears on the
-- most rows wins, so "Design" (7 devices, 255 alerts, 3 tokens) is chosen over
-- the stray lowercase "design" on a single enrollment token.
INSERT INTO "nexora_task008_org_map" ("legacy_key", "slug", "name")
SELECT DISTINCT ON (lower(btrim("label")))
	lower(btrim("label")),
	CASE
		WHEN lower(btrim("label")) IN ('', 'default') THEN 'internal-pilot'
		ELSE regexp_replace(regexp_replace(lower(btrim("label")), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')
	END,
	CASE
		WHEN lower(btrim("label")) IN ('', 'default') THEN 'Internal / Pilot'
		ELSE btrim("label")
	END
FROM (
	SELECT "organization" AS "label" FROM "nexora_devices"
	UNION ALL SELECT "organization" FROM "nexora_alerts"
	UNION ALL SELECT "organization" FROM "nexora_notifications"
	UNION ALL SELECT "organization" FROM "nexora_enrollment_tokens"
) "labels"
GROUP BY lower(btrim("label")), btrim("label")
ORDER BY lower(btrim("label")), count(*) DESC, btrim("label");--> statement-breakpoint

-- A label that slugifies to an empty string would produce a unique-key clash;
-- fold it into the pilot organization instead.
UPDATE "nexora_task008_org_map" SET "slug" = 'internal-pilot', "name" = 'Internal / Pilot' WHERE "slug" = '';--> statement-breakpoint

-- The pilot organization always exists, including on a fresh install with no
-- devices at all, so there is always somewhere to issue an enrollment token.
INSERT INTO "nexora_organizations" ("name", "slug", "notes")
VALUES ('Internal / Pilot', 'internal-pilot', 'Created by migration 0008. Holds devices enrolled before multi-tenancy, whose legacy organization label was "Default".')
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint

INSERT INTO "nexora_organizations" ("name", "slug", "notes")
SELECT DISTINCT ON ("slug") "name", "slug", 'Created by migration 0008 from the legacy free-text organization label.'
FROM "nexora_task008_org_map"
WHERE "slug" <> 'internal-pilot'
ORDER BY "slug", "name"
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint

-- Give every organization a default site. Devices are deliberately NOT attached
-- to it: site assignment stays an explicit administrative act (§D, §V), so
-- site_id remains NULL until someone places the device.
INSERT INTO "nexora_sites" ("organization_id", "name", "description")
SELECT "id", 'Main Site', 'Created by migration 0008 as the default location for this organization.'
FROM "nexora_organizations";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Add the ownership columns nullable, then backfill.
-- ---------------------------------------------------------------------------

ALTER TABLE "nexora_devices" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_alerts" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_notifications" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "actor_label" text;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "target_type" text;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD COLUMN "ip_address" text;--> statement-breakpoint

UPDATE "nexora_devices" "d" SET "organization_id" = "o"."id"
FROM "nexora_task008_org_map" "m"
JOIN "nexora_organizations" "o" ON "o"."slug" = "m"."slug"
WHERE "m"."legacy_key" = lower(btrim("d"."organization"));--> statement-breakpoint

UPDATE "nexora_enrollment_tokens" "t" SET "organization_id" = "o"."id"
FROM "nexora_task008_org_map" "m"
JOIN "nexora_organizations" "o" ON "o"."slug" = "m"."slug"
WHERE "m"."legacy_key" = lower(btrim("t"."organization"));--> statement-breakpoint

-- Alerts and notifications take their owner from the device, not from their own
-- legacy text column: the device is the authoritative tenant boundary (§F), so
-- deriving from it cannot disagree with device ownership.
UPDATE "nexora_alerts" "a" SET "organization_id" = "d"."organization_id"
FROM "nexora_devices" "d" WHERE "d"."id" = "a"."device_id";--> statement-breakpoint

UPDATE "nexora_notifications" "n" SET "organization_id" = "d"."organization_id"
FROM "nexora_alerts" "a"
JOIN "nexora_devices" "d" ON "d"."id" = "a"."device_id"
WHERE "a"."id" = "n"."alert_id";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Assert the backfill is complete before enforcing NOT NULL. A failure here
-- aborts the transaction and leaves the database exactly as it was.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
	orphan_devices bigint;
	orphan_alerts bigint;
	orphan_tokens bigint;
	mismatched_alerts bigint;
BEGIN
	SELECT count(*) INTO orphan_devices FROM nexora_devices WHERE organization_id IS NULL;
	SELECT count(*) INTO orphan_alerts FROM nexora_alerts WHERE organization_id IS NULL;
	SELECT count(*) INTO orphan_tokens FROM nexora_enrollment_tokens WHERE organization_id IS NULL;
	SELECT count(*) INTO mismatched_alerts
		FROM nexora_alerts a JOIN nexora_devices d ON d.id = a.device_id
		WHERE a.organization_id IS DISTINCT FROM d.organization_id;

	IF orphan_devices > 0 THEN
		RAISE EXCEPTION 'Task #008 migration aborted: % device(s) could not be resolved to an organization', orphan_devices;
	END IF;
	IF orphan_alerts > 0 THEN
		RAISE EXCEPTION 'Task #008 migration aborted: % alert(s) could not be resolved to an organization', orphan_alerts;
	END IF;
	IF orphan_tokens > 0 THEN
		RAISE EXCEPTION 'Task #008 migration aborted: % enrollment token(s) could not be resolved to an organization', orphan_tokens;
	END IF;
	IF mismatched_alerts > 0 THEN
		RAISE EXCEPTION 'Task #008 migration aborted: % alert(s) disagree with their device organization', mismatched_alerts;
	END IF;
END $$;--> statement-breakpoint

ALTER TABLE "nexora_devices" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_alerts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

DROP TABLE "nexora_task008_org_map";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Referential integrity and tenant-aware indexes.
-- ---------------------------------------------------------------------------

ALTER TABLE "nexora_devices" ADD CONSTRAINT "nexora_devices_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_devices" ADD CONSTRAINT "nexora_devices_site_organization_fk" FOREIGN KEY ("site_id","organization_id") REFERENCES "public"."nexora_sites"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_alerts" ADD CONSTRAINT "nexora_alerts_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_notifications" ADD CONSTRAINT "nexora_notifications_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD CONSTRAINT "nexora_enrollment_tokens_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD CONSTRAINT "nexora_enrollment_tokens_site_organization_fk" FOREIGN KEY ("site_id","organization_id") REFERENCES "public"."nexora_sites"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_enrollment_tokens" ADD CONSTRAINT "nexora_enrollment_tokens_created_by_user_id_nexora_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."nexora_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD CONSTRAINT "nexora_audit_log_actor_user_id_nexora_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."nexora_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_audit_log" ADD CONSTRAINT "nexora_audit_log_organization_id_nexora_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."nexora_organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

DROP INDEX "nexora_alerts_organization_idx";--> statement-breakpoint
CREATE INDEX "nexora_alerts_organization_idx" ON "nexora_alerts" USING btree ("organization_id","state","last_triggered_at");--> statement-breakpoint
CREATE INDEX "nexora_devices_organization_idx" ON "nexora_devices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "nexora_devices_organization_status_idx" ON "nexora_devices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "nexora_devices_organization_site_idx" ON "nexora_devices" USING btree ("organization_id","site_id");--> statement-breakpoint
CREATE INDEX "nexora_devices_organization_last_seen_idx" ON "nexora_devices" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "nexora_enrollment_tokens_organization_idx" ON "nexora_enrollment_tokens" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "nexora_audit_log_organization_idx" ON "nexora_audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "nexora_audit_log_created_idx" ON "nexora_audit_log" USING btree ("created_at");
