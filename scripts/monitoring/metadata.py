#!/usr/bin/env python3
"""Strict, bounded metadata boundary between privileged publishers and probes."""
import ipaddress
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

FIELDS = {"name", "exists", "status", "health", "restart_count", "postgres_addr"}


def read(path, max_age):
    with open(path, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_mode & 0o022:
            raise ValueError("invalid metadata file")
        if not 0 <= time.time() - info.st_mtime <= max_age:
            raise ValueError("stale metadata")
        return json.load(stream)


def container_rows(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 16:
        raise ValueError("invalid projection")
    names = set()
    for row in value:
        if set(row) != FIELDS or row["name"] in names:
            raise ValueError("invalid fields")
        names.add(row["name"])
        if not isinstance(row["name"], str) or len(row["name"]) > 128:
            raise ValueError("invalid name")
        if type(row["exists"]) is not bool or type(row["restart_count"]) is not int or row["restart_count"] < 0:
            raise ValueError("invalid state")
        if row["status"] not in {"missing", "created", "running", "paused", "restarting", "removing", "exited", "dead"}:
            raise ValueError("invalid status")
        if row["health"] not in {"none", "starting", "healthy", "unhealthy"}:
            raise ValueError("invalid health")
        if row["postgres_addr"]:
            ipaddress.ip_address(row["postgres_addr"])
    return value


def atomic_write(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".metadata-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


CORE = {"last_success_epoch", "checksum_ok", "encrypted", "off_host_ok"}
VERIFICATION = {"verified_at_epoch", "verification_ok"}
# Sanitized operational extras, a deliberately CLOSED set: anything not named
# here is rejected, so the surface reaching the unprivileged monitor cannot be
# widened by accident. No paths, no checksums, no connection strings, no keys.
OPTIONAL = {"status", "error_class", "environment", "artifact", "size_bytes",
            "restore_verified_at_epoch", "restore_ok"}
TEXT_FIELDS = ("status", "error_class", "environment", "artifact")


def backup(value):
    if not isinstance(value, dict):
        raise ValueError("invalid backup metadata")
    keys = set(value)
    if not CORE <= keys or not keys <= CORE | VERIFICATION | OPTIONAL:
        raise ValueError("invalid backup metadata")
    if type(value["last_success_epoch"]) is not int:
        raise ValueError("invalid backup metadata")
    if any(type(value[key]) is not bool for key in CORE - {"last_success_epoch"}):
        raise ValueError("invalid backup flags")
    for key in TEXT_FIELDS:
        if key in value:
            text = value[key]
            # A basename, never a path; bounded; no control characters.
            if (not isinstance(text, str) or not 0 < len(text) <= 128
                    or "/" in text or any(ord(c) < 32 for c in text)):
                raise ValueError("invalid backup detail")
    if "size_bytes" in value and (type(value["size_bytes"]) is not int or value["size_bytes"] < 0):
        raise ValueError("invalid backup size")
    if "restore_ok" in value and type(value["restore_ok"]) is not bool:
        raise ValueError("invalid restore status")
    if "restore_verified_at_epoch" in value and type(value["restore_verified_at_epoch"]) is not int:
        raise ValueError("invalid restore timestamp")
    if VERIFICATION <= keys:
        if type(value["verified_at_epoch"]) is not int or not 0 <= time.time() - value["verified_at_epoch"] <= 1800:
            raise ValueError("stale verification")
        if type(value["verification_ok"]) is not bool:
            raise ValueError("invalid verification status")
        collapsed = {key: value[key] for key in CORE}
        collapsed["checksum_ok"] = value["checksum_ok"] and value["verification_ok"]
        return collapsed
    return {key: value[key] for key in CORE}


def main():
    mode, path, *args = sys.argv[1:]
    if mode == "publish":
        atomic_write(path, container_rows(json.load(sys.stdin)))
    elif mode == "container":
        rows = container_rows(read(path, 120))
        row = next(row for row in rows if row["name"] == args[0])
        print(row[args[1]])
    elif mode == "backup":
        value = backup(read(path, 1800))
        print(value["last_success_epoch"], *(int(value[k]) for k in ("checksum_ok", "encrypted", "off_host_ok")))
    elif mode == "publish-backup":
        atomic_write(path, backup(json.load(sys.stdin)))
    else:
        raise ValueError("invalid mode")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        print("monitor metadata unavailable or invalid", file=sys.stderr)
        sys.exit(1)
