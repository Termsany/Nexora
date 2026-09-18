#!/usr/bin/env python3
"""Static artifact checks only. Never invoke the root bootstrap/validator."""
from pathlib import Path
import subprocess
import unittest

HERE = Path(__file__).resolve().parent


class ArtifactTests(unittest.TestCase):
    def test_shell_syntax(self):
        for name in ("install-staging-monitoring.sh", "staging-guard.sh", "validate-staging-runtime.sh", "runtime-probe.sh"):
            self.assertEqual(subprocess.run(["bash", "-n", str(HERE/name)]).returncode, 0)

    def test_bootstrap_masks_never_starts(self):
        code = (HERE/"install-staging-monitoring.sh").read_text()
        self.assertIn('ln -s /dev/null', code)
        for prohibited in ('systemctl enable', 'systemctl start', 'systemctl unmask', 'usermod', '/etc/sudoers'):
            self.assertNotIn(prohibited, code)

    def test_staging_guard(self):
        code = (HERE/"staging-guard.sh").read_text()
        for required in ('EUID', '/etc/nexora-staging-host', 'nexora-(postgres|api|web)-1', '/etc/nexora/environment'):
            self.assertIn(required, code)

    def test_sandbox_preserved(self):
        for name in ('nexora-platform-health.service', 'nexora-backup-verifier.service'):
            code = (HERE/'systemd'/name).read_text()
            for required in ('NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'ProtectProc=invisible', 'ProcSubset=all', 'CapabilityBoundingSet=\n', '@resources'):
                self.assertIn(required, code)
            self.assertNotIn('Group=docker', code)

    def test_validator_clones_exact_unit(self):
        code = (HERE/'validate-staging-runtime.sh').read_text()
        self.assertIn('cmp --', code)
        self.assertIn("/^OnFailure=/d", code)
        self.assertIn('trap cleanup EXIT', code)
        self.assertIn('_SYSTEMD_INVOCATION_ID=', code)

    def test_no_monitor_docker_client(self):
        code = (HERE/'platform-health.sh').read_text()
        self.assertNotIn('docker exec', code)
        self.assertIn('NEXORA_MON_PSQL', code)


if __name__ == '__main__': unittest.main(verbosity=2)
