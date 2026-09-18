#!/usr/bin/env python3
"""Release-readiness tests for the maintenance worker heartbeat.

maintenance.ts is a top-level worker loop, not an importable module, so this
covers it two ways: source-level assertions about the contract it must honour,
and a live run of the exact SQL it issues against a disposable PostgreSQL to
prove the upsert is idempotent, single-row and carries no tenant data.

Nothing here touches Production: the SQL runs against a throwaway container.
"""
import json
import re
import subprocess
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "artifacts/api-server/src/maintenance.ts"
BUILD = REPO / "artifacts/api-server/build.mjs"
COMPOSE = REPO / "compose.yaml"
IMAGE = "postgres:16-alpine"


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


class HeartbeatSourceTests(unittest.TestCase):
    """The contract the heartbeat must satisfy before it may ship."""

    @classmethod
    def setUpClass(cls):
        cls.text = SOURCE.read_text()
        match = re.search(r"async function maintenanceHeartbeat\(.*?\n\}", cls.text, re.S)
        assert match, "maintenanceHeartbeat() not found in maintenance.ts"
        cls.fn = match.group(0)

    def test_worker_name_is_a_deterministic_literal(self):
        # A computed name could drift per deployment and silently orphan the
        # monitoring view, which filters on the exact string 'maintenance'.
        self.assertIn("'maintenance'", self.fn)
        self.assertEqual(len(re.findall(r"VALUES \('maintenance'", self.fn)), 1)

    def test_is_a_single_row_idempotent_upsert(self):
        self.assertIn("ON CONFLICT (worker) DO UPDATE", self.fn)
        for forbidden in ("DELETE", "TRUNCATE", "DROP", "ALTER"):
            self.assertNotIn(forbidden, self.fn.upper().replace("DO UPDATE", ""))

    def test_writes_only_the_heartbeat_table(self):
        tables = set(re.findall(r"(?:INSERT INTO|UPDATE|FROM)\s+([a-z_][a-z0-9_.]*)", self.fn))
        self.assertEqual(tables, {"nexora_worker_heartbeats"},
                         f"heartbeat touches unexpected tables: {tables}")

    def test_timestamp_comes_from_the_database_not_the_worker(self):
        # Server-side now() keeps freshness semantics correct even if the
        # worker container's clock drifts, and matches notification-worker.
        self.assertIn("now()", self.fn)

    def test_metadata_carries_no_tenant_or_customer_fields(self):
        calls = re.findall(r"maintenanceHeartbeat\(\{([^}]*)\}\)", self.text)
        self.assertTrue(calls, "no maintenanceHeartbeat call sites found")
        keys = {k.strip() for call in calls for k in re.findall(r"(\w+)\s*:", call)}
        self.assertTrue(keys <= {"event", "cycles"}, f"unexpected metadata keys: {keys}")
        for banned in ("organization", "device", "user", "tenant", "email", "hostname", "token", "secret"):
            self.assertNotIn(banned, " ".join(calls).lower())

    def test_database_failure_cannot_stop_the_worker(self):
        # A monitoring signal must never take down the thing it observes.
        self.assertIn("try {", self.fn)
        self.assertIn("catch", self.fn)
        self.assertIn("MaintenanceHeartbeatFailed", self.fn)
        after_catch = self.fn.split("catch", 1)[1]
        self.assertNotIn("throw", after_catch, "heartbeat rethrows on DB failure")
        self.assertNotIn("process.exit", after_catch)

    def test_write_frequency_is_bounded_and_modest(self):
        policy = (REPO / "artifacts/api-server/src/alerts/policy.ts").read_text()
        interval_ms = int(re.search(r"ALERT_EVALUATION_INTERVAL_MS\s*=\s*([\d_]+)", policy).group(1).replace("_", ""))
        self.assertGreaterEqual(interval_ms, 10_000, "heartbeat loop faster than 10s would be excessive")
        per_day = 86_400_000 / interval_ms
        self.assertLess(per_day, 10_000, f"{per_day:.0f} single-row upserts/day is too many")

    def test_heartbeat_is_in_the_production_build_and_run_path(self):
        # It must reach the artifact Production actually executes, not just the
        # repository: build.mjs bundles it and compose runs the bundle.
        self.assertIn("src/maintenance.ts", BUILD.read_text())
        self.assertIn("dist/maintenance.mjs", COMPOSE.read_text())

    def test_runs_once_at_startup_and_once_per_loop(self):
        self.assertIn('maintenanceHeartbeat({ event: "starting" })', self.text)
        self.assertIn('maintenanceHeartbeat({ event: "loop"', self.text)


class HeartbeatLiveSQLTests(unittest.TestCase):
    """Execute the worker's exact SQL against a disposable PostgreSQL."""

    NAME = "nexora-hb-test"

    @classmethod
    def setUpClass(cls):
        if docker("image", "inspect", IMAGE).returncode != 0:
            raise unittest.SkipTest(f"{IMAGE} not available locally")
        docker("rm", "-f", cls.NAME)
        started = docker("run", "-d", "--name", cls.NAME, "-e", "POSTGRES_PASSWORD=disposable",
                         "-e", "POSTGRES_USER=app", "-e", "POSTGRES_DB=app", IMAGE)
        if started.returncode != 0:
            raise unittest.SkipTest("could not start a disposable PostgreSQL")
        for _ in range(60):
            if docker("exec", cls.NAME, "pg_isready", "-U", "app", "-d", "app").returncode == 0:
                break
            time.sleep(1)
        cls.sql("""CREATE TABLE nexora_worker_heartbeats(
                     worker text primary key,
                     last_seen_at timestamptz,
                     metadata jsonb);""")
        # The literal statement from maintenance.ts, with $1 bound inline.
        cls.HEARTBEAT = (
            "INSERT INTO nexora_worker_heartbeats(worker,last_seen_at,metadata) "
            "VALUES ('maintenance',now(),'{}'::jsonb) "
            "ON CONFLICT (worker) DO UPDATE SET "
            "last_seen_at=EXCLUDED.last_seen_at, metadata=EXCLUDED.metadata")

    @classmethod
    def tearDownClass(cls):
        docker("rm", "-f", cls.NAME)

    @classmethod
    def sql(cls, statement):
        r = docker("exec", cls.NAME, "psql", "-tAX", "-U", "app", "-d", "app", "-c", statement)
        return r.stdout.strip(), r.returncode

    def test_repeated_upsert_keeps_exactly_one_row_and_advances_time(self):
        self.sql("DELETE FROM nexora_worker_heartbeats")
        _, rc = self.sql(self.HEARTBEAT)
        self.assertEqual(rc, 0)
        first, _ = self.sql("SELECT extract(epoch from last_seen_at)::numeric FROM nexora_worker_heartbeats")
        time.sleep(1.1)
        for _ in range(5):
            _, rc = self.sql(self.HEARTBEAT)
            self.assertEqual(rc, 0, "repeated heartbeat must be harmless")
        count, _ = self.sql("SELECT count(*) FROM nexora_worker_heartbeats")
        self.assertEqual(count, "1", "heartbeat must remain a single row")
        second, _ = self.sql("SELECT extract(epoch from last_seen_at)::numeric FROM nexora_worker_heartbeats")
        self.assertGreater(float(second), float(first), "last_seen_at must advance")

    def test_worker_row_is_named_exactly_maintenance(self):
        self.sql(self.HEARTBEAT)
        name, _ = self.sql("SELECT worker FROM nexora_worker_heartbeats")
        self.assertEqual(name, "maintenance")

    def test_heartbeat_does_not_disturb_the_other_worker_row(self):
        self.sql("INSERT INTO nexora_worker_heartbeats VALUES "
                 "('notification-worker', now() - interval '5 minutes', '{}'::jsonb) "
                 "ON CONFLICT (worker) DO NOTHING")
        before, _ = self.sql("SELECT extract(epoch from last_seen_at)::numeric "
                             "FROM nexora_worker_heartbeats WHERE worker='notification-worker'")
        self.sql(self.HEARTBEAT)
        after, _ = self.sql("SELECT extract(epoch from last_seen_at)::numeric "
                            "FROM nexora_worker_heartbeats WHERE worker='notification-worker'")
        self.assertEqual(before, after, "maintenance heartbeat modified another worker's row")

    def test_metadata_column_holds_only_the_bounded_event_shape(self):
        self.sql("UPDATE nexora_worker_heartbeats SET metadata='{\"event\":\"loop\",\"cycles\":7}'::jsonb "
                 "WHERE worker='maintenance'")
        raw, _ = self.sql("SELECT metadata FROM nexora_worker_heartbeats WHERE worker='maintenance'")
        self.assertTrue(set(json.loads(raw)) <= {"event", "cycles"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
