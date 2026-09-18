#!/usr/bin/env python3
"""Local probe fault injection; DB/SCRAM and systemd are separate real gates."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("metadata", HERE / "metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class MonitoringTests(unittest.TestCase):
    def probe(self, domain, setup, expected):
        with tempfile.TemporaryDirectory() as tmp:
            command = f'source "{HERE}/platform-health.sh"; {setup}; check_{domain.lower() if domain != "AGENT_INGESTION" else "ingestion"}; printf "%s" "${{DOM_STATE[{domain}]}}"'
            result = subprocess.run(["bash", "-c", command], env={**os.environ, "NEXORA_MON_STATE_DIR": tmp, "NEXORA_MON_DISK_PATHS": "/"}, capture_output=True, text=True)
            self.assertEqual(result.stdout, expected, result.stderr)

    def test_projection_allowlist(self):
        row = dict(name="local-api-1", exists=True, status="running", health="healthy", restart_count=0, postgres_addr="")
        self.assertEqual(set(metadata.container_rows([row])[0]), metadata.FIELDS)
        for key in ("Env", "JWT_SECRET", "ADMIN_API_TOKEN", "ENROLLMENT_SECRET", "TELEGRAM_BOT_TOKEN", "Mounts", "HostConfig"):
            with self.assertRaises(ValueError):
                metadata.container_rows([{**row, key: "synthetic-canary"}])

    def test_metadata_staleness_and_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            metadata.atomic_write(path, {})
            self.assertEqual(metadata.read(path, 120), {})
            os.utime(path, (time.time()-121, time.time()-121))
            with self.assertRaises(ValueError): metadata.read(path, 120)
            os.utime(path, None)
            path.chmod(0o666)
            with self.assertRaises(ValueError): metadata.read(path, 120)

    def test_backup_has_no_artifact_fields(self):
        data = dict(last_success_epoch=int(time.time()), checksum_ok=True, encrypted=True, off_host_ok=True)
        self.assertEqual(metadata.backup(data), data)
        with self.assertRaises(ValueError): metadata.backup({**data, "dump": "/private"})

    def test_real_backup_metadata_reader_and_staleness(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "backup.json"
            metadata.atomic_write(path, dict(last_success_epoch=int(time.time()), checksum_ok=True, encrypted=True, off_host_ok=True))
            setup = f'BACKUP_STATE="{path}"'
            self.probe("BACKUP", setup, "HEALTHY")
            old = time.time() - 1801
            os.utime(path, (old, old))
            self.probe("BACKUP", setup, "CRITICAL")
            path.unlink()
            self.probe("BACKUP", setup, "CRITICAL")

    def test_notifier_credential_uses_stdin_only(self):
        from unittest.mock import patch
        notify_spec = importlib.util.spec_from_file_location("notify", HERE / "notify.py")
        notify = importlib.util.module_from_spec(notify_spec)
        notify_spec.loader.exec_module(notify)
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp)/"webhook").write_text(json.dumps({"url": "https://example.invalid/synthetic-canary"}))
            with patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": tmp, "NEXORA_NOTIFY_SPOOL": str(Path(tmp)/"spool")}), patch.object(notify.subprocess, "run") as run:
                run.return_value.returncode = 0
                notify.main()
                args, kwargs = run.call_args
                self.assertNotIn("synthetic-canary", str(args))
                self.assertIn("synthetic-canary", kwargs["input"])
                self.assertNotIn("synthetic-canary", (Path(tmp)/"spool").read_text())


def register(domain, case, setup, expected):
    def test(self): self.probe(domain, setup, expected)
    setattr(MonitoringTests, f"test_{domain}_{case}", test)


for case, expected in (("healthy", "HEALTHY"), ("warning", "WARNING"), ("failure", "CRITICAL"), ("permission", "UNKNOWN"), ("recovery", "HEALTHY")):
    good = case in ("healthy", "recovery")
    register("EDGE", case, 'curl(){ printf 200; }' if good else f'curl(){{ printf 000; return 1; }}; echo {1 if case == "warning" else 2 if case == "failure" else 0} > "$edge_state_file"', expected)
    register("API", case, 'container_field(){ return 1; }' if case == "permission" else 'container_field(){ case "$2" in status) echo '+('exited' if case == 'failure' else 'running')+';; health) echo healthy;; restart_count) echo '+('3' if case == 'warning' else '0')+';; esac; }', "CRITICAL" if case == "permission" else expected)
    register("DATABASE", case, 'db_query(){ return 1; }' if case in ("failure", "permission") else f'DB_LATENCY_WARN_MS={0 if case == "warning" else 100000}; DB_LATENCY_CRIT_MS=200000; db_query(){{ echo 1; }}', "CRITICAL" if case == "permission" else expected)
    register("WORKERS", case, 'container_field(){ echo running; }; db_query(){ '+('return 1;' if case == 'permission' else f'echo $((now_epoch - {700 if case == "warning" else 1900 if case == "failure" else 0}));')+' }', expected)
    backup = 'python3(){ '+('return 1;' if case == 'permission' else f'echo "$((now_epoch - {26*3600 if case == "warning" else 40*3600 if case == "failure" else 0})) 1 1 1";')+' }'
    register("BACKUP", case, backup, "CRITICAL" if case == "permission" else expected)
    register("CAPACITY", case, 'df(){ return 1; }' if case == 'permission' else 'df(){ printf "Filesystem Blocks Used Available Capacity Mounted\\n/dev/test 100 1 99 '+('80' if case=='warning' else '94' if case=='failure' else '1')+'%% /\\n"; }; MEM_AVAIL_WARN_PCT=0; MEM_AVAIL_CRIT_PCT=0; SWAP_WARN_PCT=101; SWAP_CRIT_PCT=101', expected)
    register("TLS", case, 'timeout(){ return 1; }' if case in ('failure', 'permission') else 'timeout(){ echo cert; }; openssl(){ case "$*" in *enddate*) echo "notAfter=$(date -u -d \"+'+('30' if case=='warning' else '100')+' days\")";; *issuer*) echo "issuer=Nexora Internal Root CA";; *) echo "subject=CN=test";; esac; }', "CRITICAL" if case=='permission' else expected)
    register("AGENT_INGESTION", case, 'db_query(){ return 1; }' if case=='permission' else 'db_query(){ echo "1 1 '+('20' if case=='warning' else '50' if case=='failure' else '0')+' 0"; }', expected)

if __name__ == "__main__":
    unittest.main(verbosity=2)
