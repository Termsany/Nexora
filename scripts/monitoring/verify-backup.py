#!/usr/bin/env python3
"""Privileged backup verifier. Publishes booleans/times, never artifact details.

Environment policy is EXPLICIT, never inferred. Each supported environment has
exactly one canonical backup root, and a run must name its environment in
configuration. The configured root must equal that environment's canonical
root exactly - not merely contain or resemble it - and the backup state found
there must declare the same environment. Any mismatch fails closed, which
makes cross-environment verification structurally impossible rather than
merely discouraged.

This replaces the previous staging-only design, which refused production by
rejecting any path containing the substring "production". Exact canonical
matching is strictly stronger: it rejects /tmp/fake-production AND
/home/mustafa/.nexora-backups/production, while still permitting the one
approved production root.

Legacy note: /home/mustafa/.nexora-backups/production is MIGRATION_SOURCE_ONLY.
It is deliberately NOT a canonical root - it lives under /home, which
ProtectHome=true correctly hides from this service. See
docs/backup-production-migration.md.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

from metadata import atomic_write

# The single approved backup root per environment. Adding an entry here is the
# only way to make an environment verifiable, and is a reviewable change.
CANONICAL_ROOTS = {
    "staging": "/var/lib/nexora-staging-backups",
    "production": "/var/backups/nexora",
}
CONFIG_PATH = "/etc/nexora-monitor/backup-verifier.json"
OUTPUT_PATH = "/run/nexora-monitor/backup-state.json"


def blank(error_class="unverified"):
    """A state record that asserts nothing. Published before any slow I/O so a
    kill, timeout or crash can never leave a stale success behind."""
    return dict(last_success_epoch=0, checksum_ok=False, encrypted=False,
                off_host_ok=False, verified_at_epoch=int(time.time()),
                verification_ok=False, status="failed", error_class=error_class)


def regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError("not a regular file")
    return os.fdopen(fd, "rb")


def small_json(path):
    with regular(path) as stream:
        return json.loads(stream.read(65537))


def canonical_root(environment, roots=None):
    """Resolve the one approved root for `environment`. `roots` exists so tests
    can supply disposable directories; production callers never pass it."""
    table = CANONICAL_ROOTS if roots is None else roots
    if not isinstance(environment, str) or environment not in table:
        raise ValueError("unsupported environment")
    return Path(table[environment]).resolve()


def verify(root, output, environment, roots=None):
    result = blank()
    atomic_write(output, result)
    try:
        expected = canonical_root(environment, roots)
        root = Path(root).resolve(strict=True)
        # Exact match only. No substring, prefix or "looks like" logic.
        if root != expected:
            result["error_class"] = "root_mismatch"
            raise ValueError("configured backup root is not this environment's canonical root")

        state = small_json(root / "backup-state.json")
        if state.get("environment") != environment:
            result["error_class"] = "environment_mismatch"
            raise ValueError("backup state environment does not match configured environment")

        result["error_class"] = "invalid_state"
        name = state["last_backup_file"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+\.gpg", name):
            raise ValueError("invalid filename")
        stamp = datetime.datetime.fromisoformat(state["last_success"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("timezone required")
        result["last_success_epoch"] = int(stamp.timestamp())
        if not 0 < result["last_success_epoch"] <= time.time():
            raise ValueError("invalid backup timestamp")

        result["error_class"] = "checksum_failed"
        with regular(root / (name + ".sha256")) as sidecar:
            fields = sidecar.read(1024).decode("ascii").strip().split()
        if len(fields) != 2 or fields[1].lstrip("*") != name or not re.fullmatch(r"[0-9a-f]{64}", fields[0]):
            raise ValueError("invalid checksum record")
        expected_digest = fields[0]
        if state["encrypted_sha256"] != expected_digest:
            raise ValueError("checksum state mismatch")
        with regular(root / name) as artifact:
            before = os.fstat(artifact.fileno())
            digest = hashlib.file_digest(artifact, "sha256").hexdigest()
            if digest != expected_digest:
                raise ValueError("checksum mismatch")
            result["size_bytes"] = before.st_size
            artifact.seek(0)
            result["error_class"] = "not_encrypted"
            # Fresh empty keyring, no key access, no decryption or plaintext output.
            with tempfile.TemporaryDirectory(prefix="nexora-verifier-") as home:
                packets = subprocess.run(
                    ["gpg", "--no-options", "--homedir", home, "--batch", "--list-only", "--list-packets"],
                    stdin=artifact, capture_output=True, timeout=20, env={**os.environ, "LC_ALL": "C"})
            report = packets.stdout.decode("ascii", errors="replace")
            if (packets.returncode != 0
                    or not re.search(r":(pubkey|symkey) enc packet:", report)
                    or ":encrypted data packet:" not in report
                    or ":literal data packet:" in report):
                raise ValueError("encrypted OpenPGP structure required")
            after = os.fstat(artifact.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != \
               (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                result["error_class"] = "artifact_changed"
                raise ValueError("artifact changed during verification")

        # Sanitized operational metadata only: basename, size, environment.
        # Never a full path, never a checksum value, never key material.
        result.update(checksum_ok=True, encrypted=True, verification_ok=True,
                      status="ok", error_class="none", environment=environment,
                      artifact=os.path.basename(name))

        # Restore verification is a separate, less frequent job. Carry its
        # result through if it has published one for THIS artifact.
        restore = state.get("restore_verification")
        if isinstance(restore, dict) and restore.get("artifact") == os.path.basename(name):
            if isinstance(restore.get("verified_at_epoch"), int) and isinstance(restore.get("ok"), bool):
                result["restore_verified_at_epoch"] = restore["verified_at_epoch"]
                result["restore_ok"] = restore["ok"]

        # The existing local-copy adapter is not genuine off-host protection.
        # off_host_ok stays false until a separately verified remote adapter exists.
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        keep = result.get("error_class", "unverified")
        result = blank(keep if keep != "none" else "unverified")
    atomic_write(output, result)
    return result["verification_ok"]


def main():
    if os.geteuid() != 0:
        raise ValueError("privileged verifier context required")
    config = small_json(Path(CONFIG_PATH))
    environment = config["environment"]
    if environment not in CANONICAL_ROOTS:
        raise ValueError("configuration must name a supported environment")
    ok = verify(config["backup_root"], OUTPUT_PATH, environment)
    print(f"backup verification {'succeeded' if ok else 'failed'} ({environment})")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        # Missing or invalid configuration must invalidate any previous success.
        atomic_write(OUTPUT_PATH, blank("configuration_unavailable"))
        raise SystemExit("backup verifier configuration unavailable")
