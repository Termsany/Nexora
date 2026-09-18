# Backup, restore, and secret rotation (PR-04A)

This document covers the local-only backup/restore tooling built and tested
in PR-04A, the tracked customer-dump remediation plan, and the secret
rotation runbook. **Nothing in this stage touched production** — see
"Production read-only verification" at the end.

RPO target: **<=24h**. RTO target: **<=4h**.

---

## 1. Prerequisites audit

Findings from the local host (2026-09-10), read-only, no customer data
inspected:

| Item | Finding |
| --- | --- |
| Postgres client tools on host | `pg_dump`/`pg_restore` **not installed** locally |
| Postgres server | `postgres:16-alpine` image present locally; matches the version running in every Nexora Compose stack |
| Workaround | All `pg_dump`/`pg_restore`/`psql` calls run inside a disposable `postgres:16-alpine` container via `docker run --rm --network host ...` — no local install required, and the client version always matches the server |
| Existing backup automation | None. No cron entries for `mustafa`. No `systemd` timer named `*backup*` other than the unrelated OS `dpkg-db-backup.timer`. `scripts/build-windows-agent-package.sh` and `backups/` exist but nothing schedules a DB dump today |
| `backups/` directory | Contains exactly one file: `nexora-pre-task009-20260830T222639Z.dump` (11 MB), permissions `-rw-rw-r--` (group/other-readable — too permissive for a DB dump; the new tooling writes `600`) |
| Encryption tooling | `gpg` present (`/usr/bin/gpg`); `age` **not** installed and not installed in this stage (no root/sudo access on this host — `sudo` requires a password not available here). `gpg` was already available, so PR-04A standardizes on it rather than requesting a package install that couldn't be verified safe without root |
| Local disk capacity | `/` has **3.6 GB free** of 28 GB (87% used) at time of writing. This is the binding constraint on local retention testing and on `PR-04B` — production backup planning must account for headroom before scheduling real dumps here |
| DB size conventions | Disposable end-to-end test dump (synthetic Nexora schema, 8 representative rows) was 119 KB uncompressed (`-Fc` already compresses); production's existing dump is 11 MB. Neither is close to exhausting current free space, but repeated retention (34 kept copies under the policy below) of production-sized dumps would need to be sized against actual production DB size before PR-04B |
| Volume layout | Postgres data lives in a named Docker volume (`nexora_postgres-data` for the legacy production identity; `nexora-{prod,staging,dev}_postgres-data` under the target identity — see `docs/environment-isolation.md`). Backup output is asserted (`backup_assert_safe_output_path` in `scripts/backup/lib/common.sh`) never to resolve inside a `postgres-data`/`pgdata` path or `/var/lib/docker/volumes/*` |

## 2. Architecture

```
pg_dump -Fc (via disposable postgres:16-alpine client container)
  -> temp file in backup root
  -> atomic rename
  -> SHA-256 checksum sidecar (plaintext)
  -> chmod 600
  -> gpg --encrypt (recipient = local test key)
  -> SHA-256 checksum sidecar (ciphertext)
  -> chmod 600, plaintext dump deleted
  -> backup-state.json (machine-readable, no secrets)
  -> retention.sh (daily 14 / weekly 8 / monthly 12, only after success)
  -> offhost-copy.sh local <encrypted-file> <second-local-dir>   (simulates 3-2-1 off-host leg)
```

Restore is the mirror image: verify checksum -> decrypt -> refuse a non-empty
target -> `pg_restore` -> verify `drizzle.__drizzle_migrations` is populated
-> print a restore report.

### Scripts (all under `scripts/backup/`)

| Script | Purpose |
| --- | --- |
| `lib/common.sh` | Shared guards, reusing `scripts/env/nexora-env.sh`'s production-marker list and path-safety checks so "what counts as production" has one definition repo-wide |
| `postgres-backup.sh` | Dump, checksum, encrypt, retain |
| `postgres-restore.sh` | Verify, decrypt, preflight, restore, verify migrations |
| `retention.sh` | Daily/weekly/monthly retention, dry-run by default |
| `offhost-copy.sh` | Pluggable off-host adapter (`local` implemented, `ssh` stubbed) |
| `backup-status.sh` | Reads state files, emits health JSON + alert flags |
| `systemd/nexora-backup.{service,timer}` | Reviewed templates, **not installed anywhere** |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | usage error (missing/bad argument) |
| 10 | environment rejected (production, or unknown) |
| 11 | unsafe path (escapes backup root, or looks like a volume/production path) |
| 20 | `pg_dump` failed |
| 21 | `pg_restore` failed |
| 30 | checksum computation failed |
| 40 | encryption failed |
| 41 | decryption failed |
| 42 | tamper detected (checksum mismatch on restore input) |
| 50 | retention step failed (backup itself still succeeded) |
| 60 | off-host copy failed |
| 70 | restore target database is not empty (refused) |
| 71 | migration metadata check failed after restore |

### Environment guard

`backup_env_validate()` in `lib/common.sh` accepts only `disposable`,
`development`, or `staging`. `production`, `prod`, `nexora`, `nexora-prod`,
and `nexora_prod` are refused outright, with no override flag.
`postgres-restore.sh` calls this function directly and only this function —
production restore has no override under any circumstance, in any stage.
Every connection parameter (`--pg-host`, `--pg-db`, `--pg-user`, `--input`,
backup root path) is additionally checked against `nexora-env.sh`'s
production-marker list, so a disposable run with an accidentally-inherited
production `DATABASE_URL` fragment is refused too.

`postgres-backup.sh` instead calls `backup_env_validate_for_backup()`, which
delegates to `backup_env_validate()` for everything except one additional
case: `production` (and its aliases) is accepted *only* for a backup
operation, and only after `backup_require_production_backup_approval()`
passes two separate, human-typed confirmations in the interactive shell
performing the operation:

```
export NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION'
export NEXORA_BACKUP_PRODUCTION_CONFIRM='I UNDERSTAND THIS RUNS PG_DUMP AGAINST PRODUCTION CUSTOMER DATA'
export NEXORA_RELEASE='Nexora First Customer RC1'
```

This is deliberately modeled on, and reuses,
`nexora_env_require_production_approval()` in `scripts/env/nexora-env.sh` —
but adds a *second*, backup-specific phrase on top of it, so an approval
typed for one production operation (say, a future deploy) can never silently
also authorize a `pg_dump` of customer data. Both phrases must be typed live;
neither can be satisfied by a script setting its own environment and calling
itself in the same run. When both are present, a secret-free log line records
that production backup authorization was explicitly active, including the
release name.

This gate authorizes **backup only**. `--pg-host`/`--pg-db`/`--pg-user`
production-identity checks are skipped in `postgres-backup.sh` *only* when
`NEXORA_BACKUP_ENV=production` (i.e. only after both phrases were typed) —
every other script, including `postgres-restore.sh`, `retention.sh`, and
`offhost-copy.sh`, still refuses any production identity unconditionally.
Restore, migration, and secret rotation against production remain hard-denied
with no override anywhere in this toolset.

## 3. Encryption and key recovery

Uses `gpg` (already present on this host; `age` was not installed because
installing a package requires `sudo`, which is not available without a
password on this host — see §1). A **local test key only** was generated for
PR-04A validation:

```
gpg --batch --gen-key   # RSA 3072, no expiry, no passphrase (test key only)
```

- Keyring: `.local/backup-keys/gnupg/` (gitignored — `.local/` is already
  excluded repo-wide)
- Recipient fingerprint: `.local/backup-keys/recipient.txt`
- Private key export (for testing recovery only): `.local/backup-keys/private-key-backup.asc`
- All files under `.local/backup-keys/` are `chmod 600` (dirs `700`)
- **This key is disposable test material.** It must never be reused for a
  real backup. PR-04B provisions a real production recipient key, generated
  on (or transferred to) the host that will hold the private half, with the
  public half only ever distributed to hosts that need to *encrypt*.

**Proof encrypted output cannot be restored without the key** (executed):
decrypting the same `.dump.gpg` file with an empty `GNUPGHOME` (no secret
key imported) fails with `gpg: decryption failed: No secret key` — see
Testing Summary, DECRYPTION_TEST.

### Recovery steps (documented, for the eventual real key)

1. Store the private key encrypted at rest, offline, in at least two
   independent locations (e.g., a password manager's secure-note attachment
   and a printed/paper backup in a safe) — never solely on the host that
   produces the backups.
2. To restore on a new host: import the private key
   (`gpg --import <key-file>`), verify its fingerprint matches the one
   recorded when the key was provisioned, then run
   `postgres-restore.sh <environment> --input <file>.dump.gpg ...`.
3. Rotate the backup encryption key on a schedule independent of database
   secret rotation (§6) — rotating it does not invalidate already-encrypted
   backups (decrypt with the old key, re-encrypt with the new one during a
   scheduled re-key pass, or simply keep the old private key available for
   as long as any backup encrypted under it must remain restorable).

## 4. Checksum and tamper detection

Every dump gets a `sha256sum`-format sidecar both before encryption
(`*.dump.sha256`, informational) and after (`*.dump.gpg.sha256`, the one
`postgres-restore.sh` actually checks). Restore verifies the checksum
**before** decrypting or touching any database. See Testing Summary for the
executed TAMPER_TEST (bit-flipped copy correctly refused with exit 42) and
CHECKSUM_TEST (untouched backup verifies).

## 5. Retention

Policy: keep 14 most-recent daily backups, then the oldest backup per ISO
week for up to 8 more weekly buckets, then the oldest backup per calendar
month for up to 12 more monthly buckets; anything left over is deleted.
Retention only runs after `postgres-backup.sh` reports success, operates
only on `*.dump.gpg` files directly inside the configured backup root
matching this tool's own naming convention, and supports `--dry-run` (the
default; pass `--apply` to actually delete). See Testing Summary,
RETENTION_TEST: 59 synthetic dummy files spanning ~5 years → 34 kept
(14 + 8 + 12 exactly), 25 deleted, verified both as a dry run and applied.

## 6. Off-host abstraction

`offhost-copy.sh <adapter> <src> <dest>` — no implicit destination, ever.
PR-04A implements the `local` adapter (copies the encrypted file + checksum
into a second local directory, verifies the copy's checksum, writes
`offhost-state.json`) to exercise the full pipeline end to end without a
real remote target. The `ssh` adapter is stubbed and documented: adding a
real destination later means adding one `case` branch that shells out to
`rsync -av --checksum -e "ssh -i <key>"` against
`/etc/nexora/backup/offhost.env` (host, remote path, ssh key path) —
`postgres-backup.sh`, `backup-status.sh`, and everything else in this
toolset call the adapter only by name and read its JSON status/exit code, so
no other file needs to change.

## 7. Restore guarantees

`postgres-restore.sh`:
- refuses `production`/`nexora` outright (same guard as backup)
- requires every connection parameter explicitly (no default database)
- verifies the checksum before decrypting
- decrypts before restoring (plaintext never touches disk except in a
  `mktemp -d` scratch dir cleaned up via `trap` on exit)
- refuses to restore into a target database that already has tables
  (`information_schema.tables` count > 0) unless `--force-nonempty` is
  passed — and that flag still cannot make the target production, because
  the production guard runs first and unconditionally
- after restore, verifies `drizzle.__drizzle_migrations` has rows (refuses
  to declare success on a restore that silently lost migration history)
- prints a restore report (environment, source file, verified checksum,
  target, table count, migration row count) to stderr in addition to the
  machine-readable JSON status line on stdout

## 8. Disposable end-to-end test (executed)

1. `docker run --rm -d --name nexora-pr04a-src-pg -e POSTGRES_PASSWORD=test
   -p 127.0.0.1:55450:5432 postgres:16-alpine` — disposable source
2. `drizzle-kit migrate` run against it via a `node:22-bookworm-slim`
   container (no Node/pnpm installed on this host either) → **14 migrations
   applied** (`0000`–`0013`), **31 tables created**
3. Inserted representative rows into `nexora_organizations`, `nexora_sites`,
   `nexora_users`, `nexora_organization_memberships`, `nexora_devices`,
   `nexora_alerts`, `nexora_device_metrics` (telemetry), and
   `nexora_inventory_snapshots` — all synthetic data, no real customer
   information
4. `postgres-backup.sh disposable ...` → dump, checksum, encrypt, retain
5. Bit-flip tamper test on a copy → `postgres-restore.sh` correctly refused
   (exit 42)
6. `offhost-copy.sh local` → copied encrypted file + checksum to a second
   local directory, verified post-copy checksum
7. Fresh disposable target `nexora-pr04a-tgt-pg` (127.0.0.1:55451, empty DB)
8. `postgres-restore.sh disposable --input <encrypted-file> ...` → checksum
   verified, decrypted, preflight (0 existing tables) passed, `pg_restore`
   completed, migration check passed (14 rows), report printed
9. Row-count **and** ordered-ID-checksum comparison (`md5(string_agg(id))`)
   between source and restored target for every required table — all
   matched exactly (see Testing Summary)
10. Torn down: both disposable containers stopped and removed (`--rm`), test
    directories under `.local/backup-test/` left in place only as evidence
    (gitignored, local-only)

## 9. Wrong-target / production guard tests (executed)

All of the following were run and captured (see Testing Summary):
- `postgres-backup.sh production ...` **without** `NEXORA_PRODUCTION_CONFIRM`
  and `NEXORA_BACKUP_PRODUCTION_CONFIRM` set → refused, exit 10 (this remains
  true after the PR-04B gate below: the gate adds an *approved* path, it does
  not remove the default-refused one)
- `postgres-backup.sh nexora ...` (same, unapproved) → refused, exit 10
- `postgres-restore.sh production ...` → refused, exit 10, **unconditionally,
  with no override** — `postgres-restore.sh` never calls
  `backup_env_validate_for_backup()`, only the plain `backup_env_validate()`
- `postgres-backup.sh totallybogus ...` → refused, exit 10
- `postgres-backup.sh disposable --backup-root .../postgres-data/fake-volume ...`
  → refused as an unsafe (volume-shaped) path, exit 11
- `postgres-backup.sh disposable --pg-db nexora ...` → refused, database name
  matches the production identity, exit 2
- `postgres-restore.sh disposable --pg-host nexora.design.local ...` →
  refused, host matches the production identity, exit 2
- `postgres-restore.sh disposable` into the already-populated target from
  step 8 above → refused, target not empty, exit 70

## 10. Systemd automation (template only, not installed)

`scripts/backup/systemd/nexora-backup.{service,timer}`:
- `OnCalendar=*-*-* 02:00:00` (daily, 02:00 local time), `Persistent=true`,
  `RandomizedDelaySec=300`
- `Type=oneshot` with `TimeoutStartSec=1800`; systemd itself serializes
  re-entrant starts of the same oneshot unit, and the timer's own
  `AccuracySec` plus the service timeout bound worst-case overlap
- Failure surfaced via systemd's own unit state
  (`systemctl is-failed nexora-backup.service`,
  `journalctl -u nexora-backup.service`) and `StandardOutput/Error=journal`
- Retention only runs inside `postgres-backup.sh`'s own flow, after success
  — the service unit does not need a separate retention step
- `ConditionPathExists=/etc/nexora/backup/backup.env` — the unit is inert
  until that file is provisioned
- **The service's `ExecStart` targets `production`, which
  `postgres-backup.sh` in this repo currently refuses outright.** This is
  deliberate: PR-04A does not add production capability. Before this unit
  can be installed anywhere, PR-04B must extend `backup_env_validate()` to
  accept `production` under an explicit approval gate (mirroring
  `nexora_env_require_production_approval()`), and the note is left in the
  service file itself so this isn't missed.

**Validation**: `systemd-analyze verify` was run against both files. The
timer verified clean. The service verified clean once its
`EnvironmentFile`-only paths (`ExecStart`'s binary path,
`ReadWritePaths`) were resolved to concrete filesystem paths matching what a
real install would use (systemd does not expand `EnvironmentFile` variables
in `ReadWritePaths=` — the file's comment explains this and gives the
literal path to set at install time). No manual-review fallback was needed;
`systemd-analyze` was available and used directly.

## 11. Backup health monitoring

`backup-status.sh <backup-root>` reads `backup-state.json`,
`offhost-state.json`, and `restore-test-state.json` (all written by the
scripts above, none containing secrets) and emits: `last_success`,
`last_backup_file`, `backup_age_hours`, `backup_size_bytes`,
`checksum_status`, `encryption_status`, `off_host_copy_status`,
`restore_last_tested`, `restore_last_status`, and `alerts` (comma-joined).

Alert thresholds (documented here; **no alerting is wired up** — that is a
later stage):
- `backup_age_hours > 26` → backup age alert (RPO is <=24h; 26h gives one
  missed nightly run of margin before paging)
- no successful backup ever recorded → alert
- `checksum_status = mismatch` → alert immediately
- `off_host_copy_status != success` → alert (off-host leg is part of 3-2-1)
- restore verification untested, or last tested >30 days ago → alert (a
  backup that has never been proven restorable is not a backup)

Executed: `backup-status.sh` against the disposable test backup root
returned `alerts: none` with all fields populated correctly after a
successful backup + off-host copy + a manually-recorded restore-test-state
entry (see Testing Summary).

## 12. Tracked customer dump — audit and remediation plan

**Audit (read-only, no dump contents inspected):**

- First commit that added the file:
  `8c2828ee4481e27af5b676e9675c26d6bdaec99e` ("Task #010 Windows validation
  runner preparation", 2026-08-31 03:34:25 +0300)
- Currently tracked: `git ls-files` confirms
  `backups/nexora-pre-task009-20260830T222639Z.dump` is tracked today
- No duplicate dump files found anywhere else in the working tree
  (`find . -iname '*.dump'` returns only this one path)
- Remotes configured: `origin` → `git@github.com:Termsany/Nexora.git`,
  `gitsafe-backup` → `git://gitsafe:5418/backup.git`
- **The commit that added the dump is reachable from
  `origin/main`, `origin/task010-windows-runtime-tests`, and
  `origin/fix/agent-v1-build-gate`** (`git merge-base --is-ancestor
  8c2828ee origin/task010-windows-runtime-tests` succeeds), and the current
  branch tracks `origin/task010-windows-runtime-tests`. That means this
  commit — and the 11 MB dump inside it — **has already been pushed to the
  GitHub-hosted remote**, not merely committed locally.

**Exposure assessment: CONFIRMED** (pushed to a remote-tracking branch on a
GitHub remote; not merely a local risk). This is more serious than the
prior audit's "tracked in git" framing suggested, because it establishes the
content left this machine. Whether anyone besides the repo's own
collaborators has viewed it is outside what's inspectable locally.

**Remediation plan (not executed in PR-04A — requires an explicitly approved
change):**

1. Stop tracking the file going forward: `git rm --cached
   backups/nexora-pre-task009-20260830T222639Z.dump` (the `.gitignore` rule
   already in place, `/backups/`, prevents a new one from being re-added).
2. That alone leaves the blob in history and on the pushed remote branches —
   decide, with the repo owner, whether a history rewrite
   (`git filter-repo` or BFG, targeting this specific blob) is warranted
   given it's already CONFIRMED pushed. A rewrite requires force-pushing
   every affected branch (`main`, `task010-windows-runtime-tests`,
   `fix/agent-v1-build-gate`) and coordinating with anyone else who has a
   clone, since their history will diverge.
3. Rotate any secrets that might be embedded in the dump's contents (this
   audit did not open the dump — assume the worst: if it contains
   `JWT_SECRET`, session tokens, or password hashes, treat rotation of those
   as required regardless of the history-rewrite decision, since a rewrite
   does not un-expose something already fetched by a third party). This
   folds into §13's rotation runbook for `JWT_SECRET`/`POSTGRES_PASSWORD`
   regardless.
4. After a rewrite (if approved), verify the GitHub-hosted history no
   longer contains the blob (`git log --all --oneline -- <path>` on a fresh
   clone, plus GitHub's own "Remove sensitive data" guidance for anything
   already cached in PR diffs or GitHub's own systems, which a local
   rewrite cannot reach).
5. Going forward: this stage's `postgres-backup.sh` writes only inside
   `.local/`-style gitignored roots or an explicitly-configured backup root
   outside the repo entirely — never `backups/` inside the worktree — to
   remove the recurring risk of a developer re-adding a dump to `backups/`
   by habit.

## 13. Secret rotation runbook (documented, not executed)

Rotating `JWT_SECRET` invalidates every active session immediately — every
logged-in user is signed out and must log in again. Plan a maintenance
window and notify users beforehand.

1. Announce the maintenance window; note expected session invalidation.
2. Take a fresh, verified production backup (PR-04B tooling) immediately
   before starting — this is the rollback point.
3. Generate a new `JWT_SECRET`: cryptographically random, >= 32 bytes
   (e.g. `openssl rand -base64 48`).
4. Generate a new `POSTGRES_PASSWORD` with the same standard.
5. Write both into `/etc/nexora/env/production.env` (per
   `docs/environment-isolation.md`'s model) — never into any file inside
   this git worktree.
6. On the production Postgres instance, `ALTER ROLE nexora_prod WITH
   PASSWORD '<new password>';` (or the legacy role name, pending the
   identity cutover) — this must happen with the new value already staged
   in the env file so the next container start picks it up without a gap.
7. Stop `api`, `maintenance`, and `notification-worker` (services that hold
   a live DB connection or issue/verify JWTs) — **not** `postgres`.
8. Start them again with the new `production.env` in effect.
9. Verify: a fresh login succeeds; an old session's cookie is rejected
   (expected — this is the intended session invalidation); DB connectivity
   is healthy (`docker inspect` health status, application logs).
10. Confirm no service silently fell back to the old committed default
    (`nexora-local-password` / `change-this-local-jwt-secret`) — this is
    exactly the P0-4 failure mode the prior audit found, so the check must
    be explicit, not assumed.
11. **Only after** rotation is confirmed live, land the P0-4a validator fix
    (add `JWT_SECRET`/`POSTGRES_PASSWORD` to
    `artifacts/api-server/src/security/config.ts`'s unsafe-value check) —
    landing it before rotation would make the *current* production
    container refuse to start on its next restart, per the existing audit's
    own sequencing note.
12. Remove the old committed fallback values from `compose.yaml` (or leave
    them as an intentionally-unsafe default with a startup check that now
    refuses them, per step 11).
13. Update any operator documentation/password manager entries with the new
    values; ensure the old values are not left in shell history, CI
    secrets, or other config that could reintroduce them.
14. Monitor error rates and support channels for a window after the
    rotation for anything that assumed session persistence across it.
15. Record the rotation (date, operator, reason) in an internal change log
    for audit purposes — do not record the secret values themselves.

## 14. Production read-only verification

Executed at the end of this stage, read-only only:

- `https://nexora.design.local/` → **HTTP 200**
- `docker ps` → `nexora-web-1`, `nexora-api-1`, `nexora-maintenance-1`,
  `nexora-notification-worker-1`, `nexora-postgres-1` all `Up`
- `docker inspect nexora-api-1 ... | grep REMOTE_COMMANDS_ENABLED` →
  `REMOTE_COMMANDS_ENABLED=false`
- Per-device gate count / active executable remote-command job count:
  **UNKNOWN** — no admin API credentials were available in this session to
  query a read endpoint, and direct DB access to production was avoided
  entirely per this stage's boundaries rather than guessed at. The global
  gate being `false` means no remote command can execute regardless of any
  per-device flag value, so this is a monitoring gap, not an active risk.
- `docker inspect nexora-postgres-1 --format '{{.State.StartedAt}}'` →
  `2026-09-07T21:42:10.423469293Z` both before and after this stage's work —
  **unchanged**, confirming no restart occurred.
