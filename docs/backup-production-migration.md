# Production Backup Relocation and Monitoring Readiness

Prepared during Production Self-Monitoring Blocker Remediation. **Nothing in
this document has been executed.** No real backup file has been moved, copied
or deleted, and no directory has been created on Production.

---

## 1. Why the backup root moves

| | Path |
|---|---|
| Legacy location (**MIGRATION_SOURCE_ONLY**) | `/home/mustafa/.nexora-backups/production/` |
| Canonical future location | `/var/backups/nexora` |

The backup verifier runs as a hardened systemd unit with **`ProtectHome=true`**,
which makes `/home` inaccessible to it. That is correct and deliberate: a
monitoring-adjacent service has no business reading user home directories.

The fix is to move the backups out of `/home`, **not** to weaken the sandbox.
`ProtectHome=read-only` was considered and rejected — it would expose every
user home to the backup and verifier services purely to accommodate a
directory that should never have been under `/home` in the first place.

`/var/backups` is the FHS-appropriate location, is on the same filesystem (no
capacity change), and lets `ProtectHome=true` and `ProtectSystem=strict`
remain enabled with a single explicit `ReadWritePaths=/var/backups/nexora`.

---

## 2. Verifier environment policy

`scripts/monitoring/verify-backup.py` previously refused Production three
ways: any path containing the substring `production`, and a hard
`environment == "staging"` requirement in both the backup state and its own
config. It has been refactored to an **explicit environment policy**:

```python
CANONICAL_ROOTS = {
    "staging":    "/var/lib/nexora-staging-backups",
    "production": "/var/backups/nexora",
}
```

Rules, all fail-closed:

1. Configuration must name a supported environment. **No guessing** — there is
   no default and no inference from hostname or path.
2. The configured `backup_root`, after `resolve(strict=True)`, must **equal**
   that environment's canonical root **exactly**. Not a prefix, not a
   substring, not a lookalike.
3. `backup-state.json` found there must declare the **same** environment.
4. Any mismatch publishes a failing state with an `error_class` and returns
   non-zero.

Exact matching is strictly stronger than the old substring rule. It rejects
`/tmp/fake-production` *and* `/home/mustafa/.nexora-backups/production`, while
permitting the one approved production root. Staging safety is preserved:
a staging-configured verifier still cannot verify anything under the
production root, and vice versa — cross-environment verification is
structurally impossible rather than merely discouraged.

---

## 3. Migration runbook — NOT YET EXECUTED

Preconditions: an operator with root, a maintenance window (none of this
touches the running application, but do it when you can watch it), and the
production deployment approval already understood.

### Step 0 — record the source state

```bash
ls -la /home/mustafa/.nexora-backups/production/
sha256sum /home/mustafa/.nexora-backups/production/*.dump.gpg | tee /tmp/pre-migration.sha256
```

### Step 1 — create the destination

```bash
sudo install -d -o root -g root -m 0700 /var/backups/nexora
df -h /var/backups          # confirm free space >= 2x current backup set
```

Ownership `root:root 0700`: the backup job runs as root, and the unprivileged
`nexora-monitor` must **never** be able to read raw dumps — it only ever reads
the sanitized `/run/nexora-monitor/backup-state.json` projection.

### Step 2 — copy, preserving timestamps (copy, never move)

```bash
sudo cp -a /home/mustafa/.nexora-backups/production/. /var/backups/nexora/
sudo chown -R root:root /var/backups/nexora
sudo chmod 600 /var/backups/nexora/*
```

`cp -a` preserves mtimes, which the retention policy derives buckets from.
**Copy, not move** — the source is retained until the new location is proven.

### Step 3 — verify checksums at the destination

```bash
cd /var/backups/nexora
sudo sha256sum -c *.dump.gpg.sha256
sudo sha256sum *.dump.gpg | sed 's#.*/##' > /tmp/post-migration.sha256
diff <(awk '{print $1}' /tmp/pre-migration.sha256 | sort) \
     <(awk '{print $1}' /tmp/post-migration.sha256 | sort) && echo "IDENTICAL"
```

**STOP if this differs.** Do not proceed on a checksum mismatch.

### Step 4 — point configuration at the new root (atomic cutover)

```bash
sudo tee /etc/nexora-monitor/backup-verifier.json > /dev/null <<'JSON'
{"environment":"production","backup_root":"/var/backups/nexora"}
JSON
sudo chmod 600 /etc/nexora-monitor/backup-verifier.json
```

Update `NEXORA_BACKUP_ROOT` in `/etc/nexora/backup/backup.env` to
`/var/backups/nexora`. The unit template already hard-codes
`--backup-root /var/backups/nexora`, so the two cannot drift.

### Step 5 — prove the new location before retiring the old one

Take **one full new backup** into `/var/backups/nexora`, then run a disposable
restore verification against it (§5 below). Only after **both** succeed:

### Step 6 — retire the legacy source

```bash
sudo mv /home/mustafa/.nexora-backups/production \
        /home/mustafa/.nexora-backups/production.migrated-$(date -u +%F)
```

Rename first, delete only after a further successful backup cycle. The GPG
key material under `/home/mustafa/.nexora-backups/keys/` is a **separate
decision** — do not move or delete it as part of this migration.

### Rollback

At any point before Step 6, rollback is: revert
`/etc/nexora-monitor/backup-verifier.json` and `backup.env` to the legacy
path and stop the verifier. The legacy directory is untouched throughout, so
nothing is lost. After Step 6, rename the `.migrated-*` directory back.

---

## 4. Automated backup schedule

Currently **no automated Nexora backup exists** — the only backup timer on the
host is `dpkg-db-backup` (unrelated OS housekeeping). Backups have been taken
manually; the newest artifact was ~17 h old at preflight.

Templates prepared (**not installed, not enabled**):

| Unit | Schedule | Purpose |
|---|---|---|
| `nexora-backup.{service,timer}` | daily 02:00 local, `Persistent=true`, ±300s jitter | `pg_dump -Fc` → checksum → GPG encrypt → atomic rename → retention |
| `nexora-backup-restore-check.{service,timer}` | weekly Sun 04:00 | disposable restore verification (§5) |

`postgres-backup.sh` still requires its **two typed approval phrases** for a
production target, so installing the timer cannot silently begin backing up
production without a deliberate operator action.

**Consequence to accept knowingly:** once BACKUP monitoring is enabled, it
will correctly report WARNING at 24 h and CRITICAL at 36 h until the automated
schedule is actually running. That is a true positive reporting a real gap,
not a false alarm. Enable backups **before** enabling monitoring (see the
deployment order).

---

## 5. Restore verification

A backup is not valid merely because `pg_dump` exited 0.

`scripts/backup/postgres-restore.sh` already performs: mandatory checksum
verification → mandatory decryption → restore into a **fresh disposable**
PostgreSQL container → migration-metadata verification → refusal if the target
database is not empty. It refuses `production` as a restore target
unconditionally, with no override anywhere in the toolset.

**Recommended frequency: weekly.** A full decrypt-and-restore costs minutes of
CPU and transient disk, which is disproportionate nightly for a ~115 MB
database, while every backup already receives a checksum and OpenPGP structure
check every 15 minutes. A 7-day worst-case window for detecting silent
corruption is acceptable at this scale. Increase the frequency if the database
grows materially or after any storage-layer incident.

The outcome is recorded in `backup-state.json` as:

```json
"restore_verification": {"artifact": "<basename>", "ok": true, "verified_at_epoch": 1234567890}
```

The verifier carries it into the monitoring projection **only when the
artifact name matches the backup it just verified**, so a stale restore result
from an older artifact can never vouch for a newer one.

---

## 6. Retention policy

Conservative initial production policy, unchanged from the validated
implementation: **14 daily · 8 weekly (oldest per ISO week) · 12 monthly
(oldest per month)**; anything in none of those buckets is deleted.

At ~12 MB per encrypted artifact that is a bounded ceiling of ~34 retained
artifacts (~410 MB) — comfortable on this host, which matters given the
DISK-01 history.

Safety properties, covered by `scripts/backup/test-retention.sh` (15 tests):
dry-run by default; the newest backup is never deleted; checksum sidecars
follow their artifact; non-backup files and subdirectories are untouched;
filenames without a parseable timestamp are ignored rather than deleted;
deletion cannot escape the configured root (including via a symlink); an
empty root is a clean no-op; a nonexistent root is refused.

---

## 7. WORKERS transition behaviour

The maintenance heartbeat is implemented but **not in the running Production
image** — `nexora_worker_heartbeats` currently contains only
`notification-worker`.

| Phase | maintenance | notification-worker |
|---|---|---|
| Before the heartbeat-capable release | **UNKNOWN** — container running, no heartbeat row | HEALTHY/WARNING/CRITICAL by freshness |
| After the heartbeat-capable release | HEALTHY < 10 min · WARNING 10–30 min · CRITICAL > 30 min or container down | unchanged |

This is deliberate and must not be "fixed":

- **Do not fake HEALTHY.** An absent heartbeat means the monitor genuinely
  does not know whether the worker is doing its job.
- **Do not infer liveness from container state alone.** A wedged worker inside
  a `running` container is precisely the failure this domain exists to catch;
  treating `running` as healthy would reintroduce the blind spot.
- UNKNOWN maps to overall exit code 3, distinct from healthy (0). Operators
  will see a non-green platform until the release ships, which is the honest
  signal.

Deploy the heartbeat-capable application release **before** enabling the
platform-health timer if a fully green board is wanted from the start.
