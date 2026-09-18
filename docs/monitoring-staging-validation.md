# Staging Runtime Validation Handoff

LOCAL/STAGING ONLY. The bootstrap and runtime validator have NOT been executed.
No identities, units, timers or credentials have been installed by this work.

## Canonical staging target

| Field | Value |
|---|---|
| Boundary | dedicated **VMware VM**, created by the operator at the hypervisor layer (the Production guest has no nested virtualization) |
| vCPU / RAM / disk | **2 / 4 GB / 40 GB** |
| OS | Debian 13, matching Production |
| Hostname | `nexora-staging` |
| FQDN | `nexora-staging.design.local` |
| HTTP / HTTPS | **80 / 443** |
| Database | `nexora_staging` |
| Compose project | `nexora-staging` |
| Secrets / data | staging-only; **no Production secret or data reuse** |

Full design: [staging-architecture.md](staging-architecture.md).
Provisioning: [staging-bootstrap.md](staging-bootstrap.md).

## Operator Prerequisites

Use a separately approved staging host. The root entrypoints require both the
literal `staging` argument and its exact hostname.

The canonical environment marker is a root-owned **`0400 /etc/nexora-environment`**
containing `ENVIRONMENT=staging`, `HOSTNAME=nexora-staging` and
`FQDN=nexora-staging.design.local`; `scripts/staging/staging-guard.sh` verifies
all three plus the staging Compose identity, the staging database identity, the
absence of any Production container or database identity, and the staging
filesystem marker.

*HISTORICAL:* an earlier draft used a `0600 /etc/nexora-staging-host` file
holding just the hostname. That is superseded by `/etc/nexora-environment`.

There is no production override: production hostname/environment indicators or
the established production container names cause refusal, even if a marker
exists. Docker listing failure also causes refusal. Do not create a staging
marker on the production host.

After reviewing these artifacts, an authorized root operator on staging can run:

```sh
bash scripts/monitoring/install-staging-monitoring.sh staging "$(hostname)"
```

This creates dedicated nologin accounts and root-owned runtime files, installs
vendor units under `/usr/local/lib/systemd/system`, and masks every installed
service/timer via `/etc/systemd/system`. It does not enable/start timers, change
sudoers, grant Docker access, install packages, or provision secrets. Repeating
it preserves configuration/credentials and refuses conflicting identities,
active/enabled units, existing overrides and symlinked destination paths.

## Configuration and Client

Separately provision the reviewed aggregate-view SQL and SCRAM login in STAGING
only. Provision pgpass via a protected operator channel at
`/etc/nexora-monitor/credentials/pgpass` (root:root 0600). Do not paste its contents
into logs or commands. Configure the non-secret monitor and publisher config
files described in `monitoring-least-privilege.md`.

Native host psql is NOT_REQUIRED for the host-network SCRAM test: the disposable
container client already proves that path. The monitor itself must NOT invoke
Docker. Supply an existing compatible, root-owned client (or reviewed portable
client bundle) through `NEXORA_MON_PSQL=/absolute/path/to/psql`. This executable
must run within the monitor sandbox without Docker/sudo. No package is installed
by these scripts. The runtime gate verifies this actual client under the filter.

Create root:root 0600 `/etc/nexora-monitor/runtime-validation.conf` with paths to
the ACTUAL existing staging application secret file and protected backup root:

```sh
NEXORA_VALIDATE_APP_SECRET=/absolute/staging/application.env
NEXORA_VALIDATE_BACKUP_ROOT=/var/lib/nexora-staging-backups
```

These are path settings, not secret values. The validator requires the paths,
TLS private directory and Docker socket to exist before testing access denial,
so missing targets cannot falsely pass. The config is trusted root-only shell
syntax, also compatible with systemd EnvironmentFile syntax.

## Periodic Backup Verifier

`nexora-backup-verifier.service` runs as root in a network-isolated sandbox with
no capabilities. Backup files must already be readable by that legitimate backup
context; no ACL or dump permission is weakened. Use a staging path outside `/home`
(ProtectHome remains enabled). Configure root-owned
`/etc/nexora-monitor/backup-verifier.json`:

```json
{"environment":"staging","backup_root":"/var/lib/nexora-staging-backups"}
```

The verifier reads the existing backup job's metadata, strictly validates basename,
staging marker, timestamp and sidecar, hashes the ciphertext, and checks encrypted
OpenPGP packet structure with GnuPG using a fresh empty keyring. It does not decrypt
or read GPG keys. This proves ciphertext/checksum consistency, NOT restore success
or cryptographic authenticity against a malicious backup writer.

It publishes only booleans and timestamps. Old success is invalidated before
verification; errors publish `verification_ok=false`; publication is atomic.
`verified_at_epoch` and file age enforce freshness. The timer runs every 15 minutes
WHEN an operator separately authorizes activation. It remains masked here.
Missing or stale metadata is CRITICAL. `off_host_ok=false` remains honest because
the existing local-copy adapter is not real off-host protection (BACKUP WARNING).

## Runtime Gate

After the operator prepares fresh sanitized projections and credentials, run:

```sh
bash scripts/monitoring/validate-staging-runtime.sh staging "$(hostname)"
```

It does not unmask installed units or start timers. It creates one temporary
validation service cloned from the exact approved monitor unit, changing only
ExecStart and removing OnFailure to prevent test notifications. It checks systemd
properties, runs the identity/filesystem/credential/capability probes, real
curl/openssl/df/aggregate-only psql, and the complete health script under the
unchanged syscall filter. Health WARNING/CRITICAL is not confused with inability
to run the script; explicit binary/connectivity checks must still succeed.

The runtime probe emits exactly two fixed journal markers. Validation reads only
that invocation and rejects other output without printing it. The temporary unit
is stopped/removed on exit; installed masked units and timers are unchanged.
`@resources` remains denied unless a demonstrated syscall failure justifies change.
IP address filters remain deferred pending stable staging network allocation.

Current host: noninteractive sudo requires a password. Bootstrap execution,
identity checks and V2/V4 therefore remain operator-required, NOT_VERIFIED.
Do not infer staging readiness from static tests or Docker SCRAM evidence alone.
