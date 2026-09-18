# Local/Staging Least-Privilege Monitoring

This document supersedes the Docker-group, backup-dump access, socket-auth,
notifier environment credentials, and home-directory deployment instructions
in the original PR06 draft. Nothing is installed or enabled by this change.

The prepared staging bootstrap, periodic verifier, and exact runtime-validation
procedure are now in [monitoring-staging-validation.md](monitoring-staging-validation.md).
Native host psql is not required for the proven Docker host-network SCRAM test;
the live monitor still needs a runnable unprivileged client, never Docker access.

## Boundaries

- Install executable files from `scripts/monitoring/` under `/opt/nexora-monitor`,
  root:root, directories 0755 and files 0644 (shell entrypoints run via bash).
  No repository, `.env`, Agent credentials, or application config is installed there.
- `nexora-container-state.service` is a root-owned publisher. Only this publisher
  accesses Docker. Docker access is root-equivalent even for inspect; never give
  its socket/group to monitor, notifier, or watcher.
- Publisher config is root-owned `/etc/nexora-monitor/publisher.conf`, specifying
  explicit `NEXORA_MON_COMPOSE_PROJECT` and `NEXORA_MON_COMPOSE_NETWORK`. No secrets.
  Fixed formatted inspection emits six fields per container, never full inspect.
- `/run/nexora-monitor` is root:root 0755; the atomic JSON files are 0644. Consumer
  accounts cannot replace them. Container file freshness is at most 120 seconds.
- Monitor config is root-owned `/etc/nexora-monitor/monitor.conf`: explicit base
  URL, TLS servername/address, database name, project, safe capacity mountpoints.
  Defaults cover `/`; a separate Docker filesystem needs an operator-reviewed
  traversable mountpoint, NOT access to the Docker data directory.
- `nexora-monitor` is a dedicated nologin identity with no supplementary groups,
  sudo rules, Docker access, file capabilities, or application/backup ACLs.
  Sysusers definitions are templates, not applied by this work.
- Only `/var/lib/nexora-monitor` is writable by the monitor. `/home`, `/etc/nexora`,
  Docker/containerd sockets/data and private devices are hidden in its unit.
- The independent `nexora-notify` identity has only its own state directory and
  webhook credential. `OnFailure` routes warning/critical/unknown exits there.
  It writes a generic incident to journal/stdout and spool before outbound I/O.
  Credential JSON is `{ "url": "https://..." }`; curl receives configuration
  via stdin, never URL/credentials in argv. Delivery failure leaves a failed unit
  and retained spool. There is no automatic spool delivery retry yet.
- `nexora-watch` runs on a separate host with the public CA installed; no insecure
  TLS switch. It needs no DB, Docker, application or backup credentials.

## Database

`scripts/monitoring/sql/local-staging-monitoring.sql` is an explicit operator
migration, deliberately outside the application migration journal. Never apply
it to production in this stage. It aborts on existing role names or unsafe public
grants; do not relax these guards to force installation.

The login role has only SELECT on three security-barrier aggregate views. A
separate NOLOGIN, non-superuser, non-BYPASSRLS view owner receives only necessary
columns. No role membership is granted to the login. RLS-enabled source tables
cause an explicit abort rather than returning a misleading empty aggregate.
Views expose only counts/ages and two allowlisted worker names, not IDs or PII.
No broad statistics grants are made; PostgreSQL's normal public visibility of
redacted session metadata is not equivalent to `pg_read_all_stats`.

Provision a password separately using a protected operator channel; none is in
the migration. Require `scram-sha-256` in the matching host pg_hba rule, not trust.
Use systemd `LoadCredential=pgpass:...`, with source file root:root 0600 and a
properly escaped libpq pgpass record. Monitor uses `PGPASSFILE` and `psql -w` over
TCP to the published bridge address, with connection/statement/wall timeouts.
No Docker exec, DB-owner login, password argv, or application DATABASE_URL.

## Backup Metadata

The privileged backup verifier must independently check the latest backup and
publish the following record every 15 minutes via `publish-backup-state.sh` stdin:

```json
{"last_success_epoch":1700000000,"checksum_ok":true,"encrypted":true,"off_host_ok":true}
```

It must not simply copy the existing backup-state file or infer checksum success
from a stored hash. This publisher accepts only the four-field verified record;
it does not itself validate a dump. The backup owner retains dump/hash/GPG access.
Monitor reads ONLY this projection, never the backup directory or sidecars.
After reboot/missing/invalid/future-dated or >30-minute-old metadata, BACKUP is
CRITICAL. Backup age remains WARNING at 24h and CRITICAL at 36h; missing encryption
or failed checksum is CRITICAL; unavailable off-host copy is WARNING.
Connecting the privileged verifier's periodic invocation is a staging prerequisite,
not a production backup-job change made here.

## Validation Evidence and Remaining Gates

- `python3 -B scripts/monitoring/test_monitoring.py`: local fault injection and
  actual metadata-reader/notifier contract tests. The 8-domain matrix covers
  healthy, warning, failure, permission failure, recovery (not a live outage).
- `python3 -B scripts/monitoring/test_database.py`: uniquely named tmpfs PG16,
  synthetic schema fixtures, real aggregate-view SQL, denials, host-network
  client TCP/SCRAM (including wrong password), actual Docker projection, cleanup.
  It never connects to production SQL; production container identity is read-only.
- `systemd-analyze verify scripts/monitoring/systemd/*.service scripts/monitoring/systemd/*.timer`.
- V3: IPAddressDeny/Allow deliberately deferred. Docker bridge allocation is
  dynamic and staging subnet stability has not been established.
- V2/V4 remain blocked locally: transient systemd unit start returns Access denied;
  noninteractive sudo requires a password. Host-native psql absence is not itself
  a blocker; an existing compatible client path is supported.
  Do not claim journald or curl/openssl/df/psql syscall compatibility until the
  proposed sandbox runs under an authorized local/staging service manager.
  `@resources` remains denied: no demonstrated binary failure warrants removal.
- Identities/ACLs are specified, not provisioned or verified on a staging host.
  Actual no-group/no-sudo/no-secret-access checks remain a staging prerequisite.

No `IPAddress*` filter, service installation, identity creation, production DB
change, git staging, commit, remote Git action or deployment is performed here.
Historical `run-pr06*` scripts still assume the old privileged interface and
must not be used as acceptance evidence for this least-privilege implementation.
