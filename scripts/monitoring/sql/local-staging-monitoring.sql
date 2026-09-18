-- Explicit LOCAL/STAGING migration; never included in the application journal.
-- Fresh roles only: fail rather than inherit unknown privileges. No passwords.
BEGIN;
CREATE ROLE nexora_monitor NOINHERIT LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE nexora_monitor_view_owner NOINHERIT NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA nexora_monitoring AUTHORIZATION nexora_monitor_view_owner;
REVOKE ALL ON SCHEMA nexora_monitoring FROM PUBLIC;
GRANT USAGE ON SCHEMA public, drizzle TO nexora_monitor_view_owner;
GRANT SELECT ON drizzle.__drizzle_migrations TO nexora_monitor_view_owner;
GRANT SELECT (worker, last_seen_at) ON public.nexora_worker_heartbeats TO nexora_monitor_view_owner;
GRANT SELECT (last_seen_at) ON public.nexora_devices TO nexora_monitor_view_owner;
GRANT SELECT (received_at) ON public.nexora_device_metrics TO nexora_monitor_view_owner;
GRANT SELECT (last_seen_at) ON public.nexora_device_software TO nexora_monitor_view_owner;
-- Refuse silently incomplete aggregates under an unreviewed RLS policy.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
  'public.nexora_devices'::regclass, 'public.nexora_device_metrics'::regclass,
  'public.nexora_device_software'::regclass, 'public.nexora_worker_heartbeats'::regclass,
  'drizzle.__drizzle_migrations'::regclass) AND relrowsecurity) THEN
  RAISE EXCEPTION 'Monitoring views require explicit RLS policy review';
 END IF;
END $$;
SET LOCAL ROLE nexora_monitor_view_owner;
CREATE VIEW nexora_monitoring.migration_status WITH (security_barrier=true) AS
 SELECT count(*) AS migration_count FROM drizzle.__drizzle_migrations;
CREATE VIEW nexora_monitoring.worker_heartbeats WITH (security_barrier=true) AS
 SELECT worker, extract(epoch FROM max(last_seen_at))::bigint AS last_seen_epoch
 FROM public.nexora_worker_heartbeats
 WHERE worker IN ('maintenance', 'notification-worker') GROUP BY worker;
CREATE VIEW nexora_monitoring.ingestion_status WITH (security_barrier=true) AS
 SELECT
 (SELECT count(*) FROM public.nexora_devices) AS total,
 (SELECT count(*) FROM public.nexora_devices WHERE last_seen_at > now() - interval '5 minutes') AS online,
 COALESCE((SELECT round(extract(epoch FROM now() - max(received_at))/60)::bigint FROM public.nexora_device_metrics), -1) AS last_metric_min,
 COALESCE((SELECT round(extract(epoch FROM now() - max(last_seen_at))/60)::bigint FROM public.nexora_device_software), -1) AS last_inv_min;
RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA nexora_monitoring FROM PUBLIC;
GRANT USAGE ON SCHEMA nexora_monitoring TO nexora_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA nexora_monitoring TO nexora_monitor;
ALTER ROLE nexora_monitor SET default_transaction_read_only=on;
ALTER ROLE nexora_monitor SET statement_timeout='5s';
-- This does NOT bypass RLS; a non-BYPASSRLS role errors instead of filtering.
ALTER ROLE nexora_monitor SET row_security=off;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
  'public.nexora_devices'::regclass, 'public.nexora_device_metrics'::regclass,
  'public.nexora_device_software'::regclass, 'public.nexora_worker_heartbeats'::regclass)
  AND has_any_column_privilege('nexora_monitor', oid, 'SELECT'))
  OR has_schema_privilege('nexora_monitor', 'public', 'CREATE') THEN
  RAISE EXCEPTION 'Existing PUBLIC grants violate monitoring isolation';
 END IF;
END $$;
COMMIT;
