#!/usr/bin/env python3
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-backup.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        home = self.root / "keyring"
        home.mkdir(mode=0o700)
        self.addCleanup(lambda: subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"], capture_output=True))
        self.file = self.root / "test.dump.gpg"
        # Test-only symmetric credential is passed through stdin, never argv.
        plain = self.root / "input"
        plain.write_bytes(b"synthetic-backup-not-production")
        subprocess.run(["gpg", "--no-options", "--homedir", str(home), "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--symmetric", "--output", str(self.file), str(plain)], input=b"disposable-test-only\n", capture_output=True, check=True)
        self.state = dict(environment="staging", last_backup_file=self.file.name,
                          last_success=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.refresh()
        self.output = self.root / "projection.json"

    def refresh(self):
        digest = hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.state["encrypted_sha256"] = digest
        (self.root / "backup-state.json").write_text(json.dumps(self.state))
        (self.root / (self.file.name + ".sha256")).write_text(digest + "  " + self.file.name + "\n")

    def roots(self, environment="staging"):
        """Map `environment`'s canonical root onto this test's temp directory."""
        return {environment: str(self.root)}

    def result(self, environment="staging", roots=None, root=None):
        import metadata
        ok = verifier.verify(root or self.root, self.output, environment,
                             roots if roots is not None else self.roots(environment))
        text = self.output.read_text()
        value = json.loads(text)
        # Core + verification always present; extras only from the closed set.
        self.assertTrue({"last_success_epoch", "checksum_ok", "encrypted",
                         "off_host_ok", "verified_at_epoch", "verification_ok"} <= set(value))
        self.assertTrue(set(value) <= metadata.CORE | metadata.VERIFICATION | metadata.OPTIONAL,
                        f"unexpected field published: {set(value)}")
        # Never a path, never a checksum value, never a credential.
        self.assertNotIn(str(self.root), text)
        self.assertNotIn("/", value.get("artifact", ""))
        self.assertNotIn(self.state.get("encrypted_sha256", "@@"), text)
        # The reader must accept whatever the verifier publishes.
        metadata.backup(dict(value))
        self.assertEqual(value["verification_ok"], ok)
        return ok

    def test_encrypted_checksum_success(self): self.assertTrue(self.result())
    def test_checksum_mismatch(self):
        self.file.write_bytes(b"corrupt")
        self.assertFalse(self.result())
    def test_plaintext_with_valid_checksum_rejected(self):
        self.file.write_bytes(b"not encrypted")
        self.refresh()
        self.assertFalse(self.result())
    def test_missing_sidecar(self):
        (self.root / (self.file.name + ".sha256")).unlink()
        self.assertFalse(self.result())
    def test_symlink_rejected(self):
        self.file.unlink()
        self.file.symlink_to(self.root / "input")
        self.assertFalse(self.result())
    def test_production_state_refused_under_staging_config(self):
        self.state["environment"] = "production"
        self.refresh()
        self.assertFalse(self.result("staging"))
        self.assertEqual(json.loads(self.output.read_text())["error_class"], "environment_mismatch")
    def test_failure_replaces_success(self):
        self.assertTrue(self.result())
        self.file.unlink()
        self.assertFalse(self.result())
    def test_missing_metadata(self):
        (self.root / "backup-state.json").unlink()
        self.assertFalse(self.result())
    def test_future_time_refused(self):
        self.state["last_success"] = "2999-01-01T00:00:00+00:00"
        self.refresh()
        self.assertFalse(self.result())
    def test_permission_failure_publishes_failure(self):
        from unittest.mock import patch
        with patch.object(verifier, "regular", side_effect=PermissionError()):
            self.assertFalse(self.result())
    def test_reader_rejects_stale_verification_timestamp(self):
        import metadata
        self.assertTrue(self.result())
        data = json.loads(self.output.read_text())
        data["verified_at_epoch"] -= 1801
        with self.assertRaises(ValueError): metadata.backup(data)
    def test_reader_propagates_verification_failure(self):
        import metadata
        self.file.unlink()
        self.assertFalse(self.result())
        self.assertFalse(metadata.backup(json.loads(self.output.read_text()))["checksum_ok"])


    # ---- explicit multi-environment policy -------------------------------
    def test_production_mode_succeeds_on_its_canonical_root(self):
        self.state["environment"] = "production"
        self.refresh()
        self.assertTrue(self.result("production", roots={"production": str(self.root)}))
        value = json.loads(self.output.read_text())
        self.assertEqual(value["environment"], "production")
        self.assertEqual(value["status"], "ok")
        self.assertEqual(value["artifact"], self.file.name)

    def test_staging_state_refused_under_production_config(self):
        self.state["environment"] = "staging"
        self.refresh()
        self.assertFalse(self.result("production", roots={"production": str(self.root)}))
        self.assertEqual(json.loads(self.output.read_text())["error_class"], "environment_mismatch")

    def test_root_outside_canonical_is_refused(self):
        # Correct environment and valid artifacts, but the configured root is
        # not this environment's canonical root.
        other = Path(self.tmp.name) / "elsewhere"
        other.mkdir()
        self.assertFalse(self.result("staging", roots={"staging": str(other)}))
        self.assertEqual(json.loads(self.output.read_text())["error_class"], "root_mismatch")

    def test_substring_lookalike_root_is_refused(self):
        # The old design accepted/rejected on the substring "production".
        # Exact matching rejects a lookalike even though it contains the word.
        fake = Path(self.tmp.name) / "fake-production"
        fake.mkdir()
        self.state["environment"] = "production"
        self.refresh()
        self.assertFalse(self.result("production", roots={"production": str(self.root)}, root=fake))
        self.assertEqual(json.loads(self.output.read_text())["error_class"], "root_mismatch")

    def test_unsupported_environment_refused(self):
        self.assertFalse(self.result("development", roots={"staging": str(self.root)}))

    def test_legacy_home_location_is_not_canonical_for_production(self):
        # /home/... is MIGRATION_SOURCE_ONLY and must never be canonical -
        # ProtectHome=true deliberately hides it from the verifier service.
        self.assertEqual(verifier.CANONICAL_ROOTS["production"], "/var/backups/nexora")
        self.assertNotIn("/home", verifier.CANONICAL_ROOTS["production"])
        self.assertNotEqual(verifier.CANONICAL_ROOTS["staging"],
                            verifier.CANONICAL_ROOTS["production"])

    def test_restore_verification_is_carried_through_when_matching(self):
        import time as _t
        stamp = int(_t.time())
        self.state["restore_verification"] = {"artifact": self.file.name, "ok": True,
                                              "verified_at_epoch": stamp}
        self.refresh()
        self.assertTrue(self.result())
        value = json.loads(self.output.read_text())
        self.assertTrue(value["restore_ok"])
        self.assertEqual(value["restore_verified_at_epoch"], stamp)

    def test_restore_verification_for_a_different_artifact_is_ignored(self):
        self.state["restore_verification"] = {"artifact": "some-other.dump.gpg",
                                              "ok": True, "verified_at_epoch": 1}
        self.refresh()
        self.assertTrue(self.result())
        self.assertNotIn("restore_ok", json.loads(self.output.read_text()))

    def test_failure_records_an_error_classification(self):
        self.file.unlink()
        self.assertFalse(self.result())
        value = json.loads(self.output.read_text())
        self.assertEqual(value["status"], "failed")
        self.assertNotEqual(value["error_class"], "none")


if __name__ == "__main__": unittest.main(verbosity=2)
