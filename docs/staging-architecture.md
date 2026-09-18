# Nexora Staging Environment — Architecture

Design for a **real** staging environment that does not share the Production
host's security boundary. Prepared after the Controlled Staging Runtime
Activation stage stopped at its safety gate: there is currently no staging
target, and the only available host is Production.

Nothing in this document has been provisioned. It is a design plus the
operator information required to build it.

---

## 0. Why the current host cannot host staging

Measured facts about the existing host (`Nexora`):

| Property | Value |
|---|---|
| Virtualization | VMware guest (VMware Virtual Platform, firmware 2019) |
| Nested virtualization | **Unavailable** — `/dev/kvm` absent, 0 `vmx`/`svm` CPU flags |
| Hypervisor tooling in guest | none (`virsh`, `qemu`, `lxc`, `machinectl`, `multipass`, `vagrant`, `VBoxManage` all absent) |
| `systemd-nspawn` | absent (`systemd-container` not installed) |
| Compose projects running | `nexora` (**Production**, live customer DB) and `nexora-dev` |
| systemd | single instance, PID 1, shared by everything |
| Docker | single daemon, `unix:///var/run/docker.sock` |
| Host resources | 4 vCPU, 16 GB RAM, 28 GB disk — **6.3 GB free (77% used)** |
| LAN | `ens32` = 192.168.10.224/24, gateway 192.168.10.1 |
| DNS | search `design.local`; resolvers 192.168.10.1 (not responding) and 192.168.10.200 |
| `nexora.design.local` | resolves via **`/etc/hosts` only** (127.0.1.1), not real DNS |

Because nested virtualization is unavailable **inside** this guest, a staging
VM cannot be created from here. It must be created one level up, on the
VMware host.

---

## 1. Staging boundary options — ranked

| # | Option | Verdict | Reasoning |
|---|---|---|---|
| **A** | **Separate VM on the same VMware hypervisor** | **RECOMMENDED** | Isolates every dimension that matters: own kernel + PID namespace, own systemd PID 1, own Docker daemon and socket, own filesystem and users, own PostgreSQL data, own secrets, own network identity. The hypervisor already exists, so the marginal cost is one guest. A hypervisor-level compromise is shared, but that is an acceptable residual for pre-production validation. |
| **B** | Separate physical host | ACCEPTABLE_WITH_LIMITATIONS | Strictly stronger isolation (no shared hypervisor). Rejected as the *recommendation* only on cost/logistics; if spare hardware exists, prefer it. No technical objection. |
| **C** | `systemd-nspawn` / LXC container on the Production host | **REJECT** | Gives a separate PID namespace and a nested systemd, but shares the **host kernel**, and — decisively — the validation work we need staging for is *systemd sandbox validation under root*. Provisioning it requires root on Production, container escape is a kernel-boundary problem, and disk/IO remain shared. Validating a privileged sandbox inside a container on the box you are protecting is circular. |
| **D** | Second Docker daemon on the Production host | **REJECT** | Separates Docker state only. Same kernel, same systemd PID 1, same filesystem, same users, same disk. Provides no isolation for the systemd-unit, system-user, or privilege-boundary validation that is the entire purpose of this stage. |
| **E** | Existing `nexora-dev` Compose project on the Production host | **REJECT** | See §1.1. |

### 1.1 Why `nexora-dev` is not staging

`nexora-dev` is a Compose project, not an environment boundary. It shares with
Production:

- **the same Docker daemon and socket** — anything that can drive
  `/var/run/docker.sock` to manage dev containers can equally stop, exec into,
  or read the environment of `nexora-postgres-1`. Docker-socket access is
  root-equivalent on the host.
- **the same systemd PID 1** — installing, unmasking and enabling the
  monitoring units under test *is* a mutation of Production's init system.
  There is no way to "only install them for staging".
- **the same system user namespace** — creating `nexora-monitor` creates it on
  Production.
- **the same kernel and PID namespace** — a sandbox-escape test that succeeds
  lands on Production.
- **the same filesystem and disk** — `/etc`, `/opt`, `/var/lib`, `/run` are
  shared; the DISK-01 incident showed disk exhaustion is a live, shared
  failure mode.
- **the same LAN identity** — one IP, one hostname, one certificate store.

The specific thing staging must validate — *a least-privilege systemd runtime
under real root provisioning* — cannot be validated on `nexora-dev` without
performing that exact privileged provisioning on Production. `nexora-dev`
remains valuable for application-level development. It is not a staging
environment, and the safety guard must continue to refuse it.

### 1.2 Isolation matrix of the recommended option

| Dimension | Isolated by a separate VM? |
|---|---|
| PID namespace | ✅ own kernel |
| systemd instance | ✅ own PID 1 |
| Docker daemon/socket | ✅ own daemon |
| PostgreSQL data | ✅ own volume on own disk |
| Filesystem paths | ✅ entire filesystem |
| Secrets | ✅ own `/etc/nexora/env/staging.env` |
| System users | ✅ own `/etc/passwd` |
| Monitoring units | ✅ own `/etc/systemd/system` |
| Runtime state | ✅ own `/run`, `/var/lib` |
| Network identity | ✅ own IP, hostname, certificate |
| Hypervisor | ❌ shared (accepted residual; option B removes it) |

---

## 2. Minimum staging VM specification

Sized from **measured** Production footprint, not guesswork. The whole
five-container Production stack currently uses **~279 MB RSS** combined
(api 73 MB, postgres 126 MB, maintenance 44 MB, worker 30 MB, web 6 MB) and
its Postgres volume is **213 MB** with real customer data.

| Resource | Minimum | Recommended | Rationale |
|---|---|---|---|
| vCPU | 2 | **2** | Runtime load is negligible; CPU matters only if images are built on the box. 2 is sufficient even for builds. |
| RAM | 2 GB | **4 GB** | Runtime needs ~300 MB + Debian ~400 MB + dockerd ~100 MB. 2 GB suffices **only** if images are pre-built elsewhere and transferred. 4 GB covers on-box `docker build` (the Node/pnpm build spikes to 1–2 GB) and gives Postgres cache headroom. |
| Disk | 32 GB | **40 GB** | Debian minimal ~3 GB + images ~2 GB (api 342 MB, web 75 MB, migrate 944 MB, postgres 420 MB) + build cache 2–3 GB + Postgres volume + backups + journal. Production hit 94% on a 28 GB disk (DISK-01); do not repeat that. 40 GB gives real headroom. |
| Swap | **2 GB** | 2 GB | Matches RAM class. Production currently sits at 39% swap on 1.6 GB, which is already a mild smell — give staging room. |
| OS | **Debian 13 (trixie)** | same | Matches Production (`6.12.101+deb13-amd64`). Staging must match the Production OS family or it validates nothing about the deployment. |
| Filesystem | ext4 | ext4 | Matches Production. |
| Network | 1 NIC, static IPv4 on the 192.168.10.0/24 LAN | same | See §9. |
| Hostname | `nexora-staging` | — | §3 |
| DNS name | `nexora-staging.design.local` | — | §3, §6 |

**Do not oversize.** If the box is only ever used for monitoring/sandbox
validation and never builds images, 2 vCPU / 2 GB / 32 GB is genuinely enough.

---

## 3. Staging identity and the environment marker

| Field | Staging value |
|---|---|
| Hostname | `nexora-staging` |
| FQDN / DNS | `nexora-staging.design.local` |
| Compose project | `nexora-staging` |
| Database | `nexora_staging` |
| Environment marker | `/etc/nexora-environment` |

### The marker

A single immutable file both environments carry, so every script can make a
positive identification rather than inferring from hostname alone.

**Staging host** — `/etc/nexora-environment`, `root:root`, mode `0400`:

```
ENVIRONMENT=staging
HOSTNAME=nexora-staging
FQDN=nexora-staging.design.local
PROVISIONED=<ISO-8601 date>
```

**Production host** — `/etc/nexora-environment`, `root:root`, mode `0400`:

```
ENVIRONMENT=production
HOSTNAME=Nexora
FQDN=nexora.design.local
PROVISIONED=<ISO-8601 date>
```

Rules:
- Mode `0400` `root:root`, and **must not be a symlink** (the guard checks).
- Created once by the operator at provisioning time; never written by any
  automation, never templated from the repo, never in git.
- Absence is **not** treated as "probably staging" — absence fails closed.
- The Production marker is as important as the staging one: it lets any
  script positively refuse a host that declares itself production, instead of
  relying only on container-name heuristics.

**Neither marker is created by this stage.**

> **Canonicalized.** `nexora-staging.design.local` on **80/443** is now the
> single supported staging identity, applied across `scripts/env/nexora-env.sh`,
> `compose.staging.yaml`, `.env.staging.example`, the TLS SAN and the guard.
>
> *HISTORICAL:* an earlier draft used `staging.nexora.design.local` with ports
> **8081/8444**. Those offsets existed only to avoid colliding with Production
> on a shared host. That design is obsolete and is deliberately **not** retained
> as an alternate staging mode — the staging guard now actively refuses the
> legacy FQDN. The 8080/8443 offsets remain correct for the separate
> **development** profile, which is a different thing from staging.

---

## 4. Filesystem and data separation

Staging uses the same *path layout* as Production but on its own filesystem,
so runbooks transfer unchanged while sharing nothing.

| Path | Purpose | Owner / mode |
|---|---|---|
| `/opt/nexora` | application source / compose files | `root:root 0755` |
| `/etc/nexora-environment` | environment marker | `root:root 0400` |
| `/etc/nexora/env/staging.env` | staging secrets | `root:root 0600` |
| `/etc/nexora/pki/ca/` | staging CA public cert | `root:root 0755` |
| `/etc/nexora/pki/server/` | staging server cert + key | `root:root 0700` |
| `/srv/nexora/staging/downloads/` | staging Agent packages | `root:root 0755` |
| `/opt/nexora-monitor/` | monitoring scripts | `root:root 0755` |
| `/etc/nexora-monitor/` | monitor config | `root:root 0755` |
| `/etc/nexora-monitor/credentials/pgpass` | monitor DB credential | `root:root 0600`, delivered via `LoadCredential=` |
| `/run/nexora-monitor/` | publisher output (container-state, backup-state) | `root:root 0755`, files `0644` |
| `/var/lib/nexora-monitor/` | monitor runtime state | `nexora-monitor:nexora-monitor 0700` |
| `/var/log/nexora-monitor/` | monitor incident spool | `nexora-monitor:nexora-monitor 0700` |
| `/var/lib/nexora-backup-status/` | staging backup metadata | `root:root 0755` |
| `/var/backups/nexora-staging/` | staging backup artifacts | `root:root 0700` |

Independently owned by staging, sharing nothing with Production:
Docker volumes · PostgreSQL volume (`nexora-staging_postgres-data`) ·
environment file · TLS certificate **and private key** · monitoring state ·
backup state and artifacts · backup encryption key · Agent enrollment secret ·
all application secrets.

---

## 5. Staging database

| Item | Value |
|---|---|
| Database | `nexora_staging` |
| Volume | `nexora-staging_postgres-data` (separate Docker volume, separate VM) |
| Engine | `postgres:16-alpine` — same major version as Production |

### Role hierarchy

| Role | Attributes | Purpose |
|---|---|---|
| `nexora_staging` | `LOGIN`, owns the schema | Application role used by api / maintenance / notification-worker. **Not** a superuser — this is a deliberate improvement on Production, where the app role is currently `rolsuper=t`. |
| `nexora_migrate` | `LOGIN`, DDL on the app schema only | Runs migrations. Optional; may be folded into the app role initially, but keeping it separate lets staging prove the split before Production adopts it. |
| `nexora_monitor` | `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, `ALTER ROLE … SET default_transaction_read_only = on` | Self-monitoring. Granted `USAGE` on schema `nexora_monitoring` and `SELECT` on its **aggregate views only** — never on base tables, never on anything containing customer/PII columns. |

`nexora_monitoring` exposes only aggregates, e.g. `migration_status`
(a count) and `worker_heartbeats` (worker name + epoch). The monitor role must
not be able to read `nexora_users`, `nexora_devices`, `nexora_audit_log`, or
any other base table.

**Data policy:** no Production credentials, no Production dump, no customer
data. Staging is seeded with **synthetic** organizations, sites, users and
devices only (the PR-05B disposable-customer pattern is the model). If
Production-shaped data is ever needed for a specific test, it must be
explicitly sanitized first and that sanitization reviewed — never a raw
restore.

---

## 6. TLS and DNS

| Item | Value |
|---|---|
| DNS name | `nexora-staging.design.local` |
| CN | `nexora-staging.design.local` |
| SAN | `DNS:nexora-staging.design.local`, `DNS:nexora-staging`, `IP:<staging IP>` |
| Issuer | Nexora Internal Root CA |
| Key | Generated **on the staging host**, never leaves it |

The existing internal CA at `/etc/nexora/pki/ca` on Production is appropriate
to use as the issuer — clients and Agents already trust it, and staging should
exercise the same trust path Production uses.

Hard rules:
- The **CA private key never leaves the Production host.** Generate the CSR on
  staging, carry only the CSR to the CA, carry back only the signed
  certificate.
- **Never copy `/etc/nexora/pki/server/*` from Production.** That directory is
  `root:root 0700` and holds the Production server key; reusing it would make
  staging able to impersonate Production.
- Staging gets its own keypair with its own SAN. A staging cert must fail
  hostname verification against `nexora.design.local`, by design.

Optionally, a dedicated **Nexora Staging CA** gives full cryptographic
separation and guarantees a staging cert can never be presented as
Production. Cost: test Agents must trust an extra root. Recommended if Agent
trust configuration is cheap in your fleet; the shared CA is acceptable
otherwise.

---

## 7. Docker Compose topology

Project name: **`nexora-staging`** (already set by `compose.staging.yaml`).

Services — `postgres`, `migrate`, `api`, `web`, `maintenance`,
`notification-worker` — all derived from the base `compose.yaml` plus the
staging overlay, giving container names `nexora-staging-api-1`,
`nexora-staging-postgres-1`, etc. Those names are what the safety guard uses
as positive staging identity, and their **absence** of
`nexora-(postgres|api|web)-1` is what proves it is not Production.

Key properties already encoded in `compose.staging.yaml`, all correct and
worth preserving:

- `build: !reset null` + `image: ${NEXORA_IMAGE_*}` + `pull_policy: never` —
  staging runs **immutable release-candidate images**, never a rebuild from a
  dirty worktree. This is exactly right and should not be relaxed.
- All secrets come from `/etc/nexora/env/staging.env` via `:?` required-
  variable syntax, so a missing staging secret fails the stack rather than
  silently falling back.
- Separate PKI mount and separate downloads root, so staging cannot serve or
  overwrite the customer-visible Agent package.
- `REMOTE_COMMANDS_ENABLED` defaults to `false`, matching first-customer
  policy.

Port mapping is `80:80` / `443:443`, already applied to
`compose.staging.yaml`. The PKI mount is likewise the standard
`/etc/nexora/pki/server` rather than the old `/etc/nexora/pki/staging`
subdirectory, since on a dedicated VM the whole filesystem belongs to staging.

Self-monitoring (`platform-health`, publishers, notifier, external watcher)
layers on top once the stack is up, per
[monitoring-least-privilege.md](monitoring-least-privilege.md).

---

## 8. Secrets model

Every staging secret is **generated fresh on the staging host** and is unique
to staging:

`JWT_SECRET` · `ADMIN_API_TOKEN` · `ENROLLMENT_SECRET` · `POSTGRES_PASSWORD`
(and the derived `DATABASE_URL`) · `nexora_monitor` DB password ·
backup encryption key · notification test credentials (staging Telegram chat /
staging mailbox / test webhook only).

Rules:
- Generated with `openssl rand -hex 48` (or equivalent), independently per
  secret — never derived from one another.
- **Never copied from Production.** Reusing a Production secret in staging
  turns staging into a Production credential store and destroys the reason for
  having a separate environment.
- Never committed. `.env.staging.example` is a template with deliberately
  invalid placeholders; the real file exists only at
  `/etc/nexora/env/staging.env`, `root:root 0600`.
- Never passed on a command line (argv is world-readable via `/proc`), never
  echoed to logs or the journal.
- The monitor's DB credential is delivered by systemd `LoadCredential=` into
  `$CREDENTIALS_DIRECTORY`, not via an environment variable.
- Notification destinations must be staging-only. A staging alert must never
  reach a customer-facing channel.

**No secrets are generated by this stage.**

---

## 9. Network design

Known topology (measured): LAN `192.168.10.0/24`, gateway `192.168.10.1`,
Production host `192.168.10.224`, DNS resolvers `192.168.10.1` (not
responding) and `192.168.10.200` (responding). Search domain `design.local`.
`nexora.design.local` currently resolves **only through `/etc/hosts`**, not
real DNS.

| Requirement | Design |
|---|---|
| Staging IP | A **static** address on `192.168.10.0/24`, outside the DHCP pool. **The operator must supply it** — the pool boundaries are not discoverable from inside this guest. Do not assume one. |
| Workstation → staging HTTPS | `https://nexora-staging.design.local` (443). Requires the name to resolve for the workstation. |
| Staging → internal DNS | `192.168.10.200` (the resolver that answers). |
| Test Agents → staging API | `https://nexora-staging.design.local/api` over 443. |
| Name resolution | Preferred: an **A record** for `nexora-staging.design.local` → staging IP on the `192.168.10.200` DNS server. Fallback: `/etc/hosts` entries on the staging host and each test client — workable but does not scale and is easy to get wrong. |

### Preventing cross-environment enrollment

Three independent mechanisms, each sufficient alone:

1. **Distinct API base URL.** An Agent is configured at install time with
   `-ApiBaseUrl https://nexora-staging.design.local/api`. It talks only to the
   host that name resolves to. A Production Agent pointed at
   `nexora.design.local` never contacts staging.
2. **Distinct enrollment secret and tokens.** Enrollment tokens are
   `sha256`-hashed per environment and stored only in that environment's
   database. A staging token presented to Production hashes to a value with no
   matching row → `401`. The reverse is equally true. There is no shared
   secret that could make a token valid in both.
3. **Distinct TLS identity.** A staging Agent that strictly verifies
   `nexora-staging.design.local` will reject Production's certificate on
   hostname mismatch, and vice versa. This is why staging must **not** reuse
   the Production server key.

Operationally, also: keep staging Agents on clearly-labelled test machines,
and never publish a staging Agent package to the customer-visible downloads
path (already enforced by the separate downloads root and by
`build-windows-agent-package.sh`'s `NEXORA_AGENT_OUT_DIR` guard).

---

## 10. Staging backup / restore

Purpose: exercise the backup and restore workflow end to end without touching
Production backups or Production encryption material.

| Item | Staging value |
|---|---|
| Backup root | `/var/backups/nexora-staging/` (`root:root 0700`) |
| State metadata | `/var/lib/nexora-backup-status/backup-state.json` |
| Encryption key | A **staging-only** GPG keypair generated on the staging host; Production's backup key is never copied |
| Retention | Same policy shape as Production (14 daily / 8 weekly / 12 monthly), shorter is fine |
| Off-host copy | Optional for staging; if configured, a staging-only destination |

Rules:
- Reuses `scripts/backup/` unchanged — that is part of what staging validates.
- **No Production dump is ever restored into staging** unless explicitly
  sanitized and reviewed first. The verified Production backup artifact and
  its key stay on Production.
- The staging backup verifier publishes sanitized metadata only (age, size,
  checksum status) to `/run/nexora-monitor/backup-state.json`; the
  `nexora-monitor` user never gets read access to the dumps, the checksum
  sidecars, the GPG private material, or the backup root itself.

---

## 11. Safety guard design

`scripts/staging/staging-guard.sh` supersedes the earlier
`scripts/monitoring/staging-guard.sh` concept. It requires **all six** of the
following, and refuses on any single failure:

1. `/etc/nexora-environment` exists, is a regular file (not a symlink), is
   `root:root`, mode `0400`, and contains `ENVIRONMENT=staging`.
2. Hostname matches staging policy (`nexora-staging`) **and** matches the
   `HOSTNAME=` line in the marker.
3. The staging Docker project identity exists — at least one
   `nexora-staging-*` container is present.
4. **No** Production container identity is present — none of
   `nexora-postgres-1`, `nexora-api-1`, `nexora-web-1`,
   `nexora-maintenance-1`, `nexora-notification-worker-1`.
5. The staging database identity matches — a reachable Postgres whose database
   is `nexora_staging`, and **no** database named `nexora` on that daemon.
6. A staging filesystem marker is present: `/etc/nexora/env/staging.env`
   exists `root:root 0600`, and the Production env file `/etc/nexora/.env` is
   absent.

Additional hard checks: refuse if `ENVIRONMENT=production` appears anywhere in
the marker; refuse if the hostname contains a production indicator; refuse if
`$NEXORA_ENV`/`$NODE_ENV` say production.

**No override by default.** An emergency override is deliberately *not*
implemented. If one is ever added it must require an explicit environment
variable, print a loud multi-line warning, and be justified in writing — but
the correct answer to "the guard is refusing" is almost always "the target is
wrong", as it was in the previous stage.

---

## 12. What the operator must supply

The following cannot be determined from inside this guest and must be provided
before provisioning:

1. **VMware access** — vCenter/ESXi endpoint (or Workstation host) with
   permission to create a guest. This guest has no nested virtualization, so
   the VM must be created one level up.
2. **Datastore capacity** — confirmation that ≥40 GB is available.
3. **Static IP** — a free address on `192.168.10.0/24` outside the DHCP pool,
   plus confirmation of the pool boundaries.
4. **DNS control** — whether an A record for `nexora-staging.design.local` can
   be created on `192.168.10.200`, or whether `/etc/hosts` fallback is
   required. Also worth resolving why `192.168.10.1` does not answer DNS.
5. **Debian 13 install media** on the datastore.
6. **CA signing access** — who can run the signing step on the Production host
   (the CA private key must not move), or approval to create a separate
   Staging CA.
7. **Resolved — no action.** The staging identity is canonicalized to
   `nexora-staging.design.local` on 80/443 across every active artifact.
8. **Release-candidate image transport** — how pinned RC images reach staging
   (registry, or `docker save`/`load`), since `pull_policy: never` means they
   must be present locally.
