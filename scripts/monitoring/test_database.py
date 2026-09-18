#!/usr/bin/env python3
"""Disposable PostgreSQL test. No application/production connections or volumes."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
prefix = "nexora-monitor-test-" + secrets.token_hex(4)
name = prefix + "-postgres-1"
password = secrets.token_hex(32)
passed = 0


def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def check(ok, label):
    global passed
    if not ok:
        raise RuntimeError(label)
    passed += 1
    print("PASS " + label, flush=True)


def admin(sql):
    result = run(["docker", "exec", "-i", name, "psql", "-X", "-U", "postgres", "-d", "monitor_test", "-v", "ON_ERROR_STOP=1", "-tAc", sql])
    if result.returncode:
        raise RuntimeError("disposable DB setup/query failed")
    return result.stdout.strip()


def monitor(sql, credential=password):
    return run(["docker", "run", "--rm", "--network", "host", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", "PGPASSWORD", "--entrypoint", "psql", "postgres:16-alpine", "-X", "-w", "-h", address, "-U", "nexora_monitor", "-d", "monitor_test", "-v", "ON_ERROR_STOP=1", "-tAc", sql], env={**os.environ, "PGPASSWORD": credential})


baseline = run(["docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}}", "nexora-postgres-1"]).stdout.strip()
try:
    check(run(["docker", "network", "create", prefix]).returncode == 0, "isolated network")
    result = run(["docker", "run", "-d", "--name", name, "--network", prefix, "--memory", "256m", "--tmpfs", "/var/lib/postgresql/data:rw,size=192m", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=monitor_test", "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", "postgres:16-alpine", "-c", "log_connections=on"], env={**os.environ, "POSTGRES_PASSWORD": password})
    check(result.returncode == 0, "disposable tmpfs database")
    for _ in range(40):
        # The bootstrap Unix-socket server is not the final TCP server.
        if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "monitor_test"]).returncode == 0: break
        time.sleep(1)
    address = run(["docker", "inspect", "--format", '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]).stdout.strip()
    admin("""
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations(id int);
CREATE TABLE nexora_devices(id int, last_seen_at timestamptz, secret text);
CREATE TABLE nexora_worker_heartbeats(worker text, last_seen_at timestamptz, metadata jsonb);
CREATE TABLE nexora_device_metrics(received_at timestamptz);
CREATE TABLE nexora_device_software(last_seen_at timestamptz);
INSERT INTO nexora_devices VALUES (1, now(), 'synthetic-PII-canary');
INSERT INTO nexora_worker_heartbeats VALUES ('maintenance', now(), '{}');
INSERT INTO nexora_device_metrics VALUES (now());
INSERT INTO nexora_device_software VALUES (now());
""")
    admin((HERE / "sql/local-staging-monitoring.sql").read_text())
    # Test-only password sent through stdin, never argv or output.
    result = run(["docker", "exec", "-i", name, "psql", "-X", "-U", "postgres", "-d", "monitor_test", "-v", "ON_ERROR_STOP=1"], input=f"ALTER ROLE nexora_monitor PASSWORD '{password}';\n")
    check(result.returncode == 0, "role provisioned")
    for sql in ("SELECT 1", "SELECT * FROM nexora_monitoring.migration_status", "SELECT * FROM nexora_monitoring.worker_heartbeats", "SELECT * FROM nexora_monitoring.ingestion_status"):
        result = monitor(sql)
        check(result.returncode == 0 and "canary" not in result.stdout, sql)
    for sql in ("SELECT * FROM nexora_devices", "SELECT * FROM nexora_worker_heartbeats", "SET ROLE nexora_monitor_view_owner", "SET default_transaction_read_only=off; DELETE FROM nexora_devices", "SET default_transaction_read_only=off; CREATE TABLE public.forbidden(id int)", "SET default_transaction_read_only=off; UPDATE nexora_monitoring.worker_heartbeats SET last_seen_epoch=0"):
        check(monitor(sql).returncode != 0, "DENIED " + sql)
    result = monitor("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user")
    check(result.returncode == 0 and result.stdout.strip() == "f|f|f|f|f", "all privileged role flags false")
    result = monitor("SELECT pg_has_role(current_user, 'pg_monitor', 'MEMBER'), pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')")
    check(result.returncode == 0 and result.stdout.strip() == "f|f", "no broad pg_stat_activity grant")
    check(monitor("SELECT 1", "wrong-disposable-password").returncode != 0, "wrong password rejected across host TCP")
    logs = run(["docker", "logs", name])
    check("method=scram-sha-256" in logs.stdout + logs.stderr, "host namespace TCP authenticated with SCRAM")
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary) / "container-state.json"
        result = run(["bash", str(HERE / "publish-container-state.sh")], env={**os.environ, "NEXORA_MON_COMPOSE_PROJECT": prefix, "NEXORA_MON_COMPOSE_NETWORK": prefix, "NEXORA_MON_CONTAINER_STATE": str(target)})
        check(result.returncode == 0, "actual Docker fixed projection publication")
        value = json.loads(target.read_text())
        fields = {"name", "exists", "status", "health", "restart_count", "postgres_addr"}
        check(len(value) == 4 and all(set(row) == fields for row in value) and password not in target.read_text(), "exact projection allowlist and no environment secrets")
finally:
    run(["docker", "rm", "-f", name])
    run(["docker", "network", "rm", prefix])
    current = run(["docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}}", "nexora-postgres-1"]).stdout.strip()
    check(bool(baseline) and baseline == current, "production PostgreSQL identity/start preserved")
print(f"DATABASE_PROJECTION_TESTS={passed}/{passed}")
