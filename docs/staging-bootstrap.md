# Nexora Staging — First Bootstrap Runbook

Operator runbook for provisioning the staging machine designed in
[staging-architecture.md](staging-architecture.md).

**Every step runs on the NEW staging VM.** Nothing here is executed on the
Production host `Nexora` except the single clearly-marked CA signing step in
§8, which touches only the CA and never leaves the Production host's key
behind.

Prerequisites: the eight operator inputs listed in
[staging-architecture.md §12](staging-architecture.md#12-what-the-operator-must-supply).

Throughout: `<STAGING_IP>` is the static address you were allocated.

---

## 1. Create the VM and install Debian

At the **VMware layer** (not from inside the Production guest — it has no
nested virtualization):

| Setting | Value |
|---|---|
| Guest OS | Debian 13 (64-bit) |
| vCPU | 2 |
| RAM | 4096 MB (2048 MB minimum if images are never built on-box) |
| Disk | 40 GB, thin provisioned |
| NIC | same port group / VLAN as Production, so the LAN and DNS are reachable |

Install Debian 13 minimal: **no** desktop, **yes** SSH server and standard
system utilities. Partition as a single ext4 root with a **2 GB swap**
partition or swapfile.

Verify after first boot:

```bash
systemd-detect-virt          # expect: vmware
free -m | awk '/Swap:/{print $2" MB swap"}'
df -h / | tail -1
```

## 2. Hostname

```bash
sudo hostnamectl set-hostname nexora-staging
hostnamectl                                     # confirm
```

Ensure `/etc/hosts` has a sane loopback entry and does **not** claim any
Production name:

```
127.0.0.1   localhost
127.0.1.1   nexora-staging.design.local nexora-staging
```

## 3. Network and DNS

Set a **static** address (NetworkManager, `systemd-networkd`, or
`/etc/network/interfaces` — match the distro default):

```
address  <STAGING_IP>/24
gateway  192.168.10.1
dns      192.168.10.200
search   design.local
```

Preferred: create the DNS **A record** `nexora-staging.design.local` →
`<STAGING_IP>` on `192.168.10.200`.

Fallback if you do not control DNS: add the mapping to `/etc/hosts` on the
staging host, your workstation, and every test Agent machine. This works but
does not scale — prefer the A record.

Verify:

```bash
ip -4 -o addr show scope global
getent hosts nexora-staging.design.local        # must return <STAGING_IP>
ping -c1 192.168.10.200
```

## 4. Docker and Compose

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl python3 jq
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker --version && docker compose version
```

Configure log rotation and a build-cache ceiling **now**, not after the first
disk incident (this is the DISK-01 lesson) — `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "builder": { "gc": { "enabled": true, "defaultKeepStorage": "4GB" } }
}
```

```bash
sudo systemctl restart docker
```

## 5. Get the Nexora source onto the box

```bash
sudo install -d -o root -g root -m 0755 /opt/nexora
sudo git clone <repo-url> /opt/nexora      # or: rsync a clean checkout
cd /opt/nexora && git status --short       # must be CLEAN
```

Staging validates **release-candidate images**, not a worktree build. Never
run the stack from a dirty tree.

Load the pinned RC images (registry pull, or transfer):

```bash
docker load -i nexora-api-<tag>.tar
docker load -i nexora-web-<tag>.tar
docker load -i nexora-migrate-<tag>.tar
docker images | grep nexora
```

## 6. Create the environment marker

This is what every safety guard keys off. Create it **before** anything
privileged runs.

```bash
sudo tee /etc/nexora-environment > /dev/null <<EOF
ENVIRONMENT=staging
HOSTNAME=nexora-staging
FQDN=nexora-staging.design.local
PROVISIONED=$(date -u +%F)
EOF
sudo chown root:root /etc/nexora-environment
sudo chmod 0400 /etc/nexora-environment
ls -l /etc/nexora-environment              # expect -r-------- root root
```

> **Separately, on the Production host**, an operator should create the
> matching production marker so scripts can positively identify it:
> `ENVIRONMENT=production` / `HOSTNAME=Nexora` / `FQDN=nexora.design.local`,
> same `root:root 0400`. That is
> a Production change and requires its own approval — it is **not** part of
> this runbook.

## 7. Generate staging-only secrets

Every value is generated **here**, on this host. Never copy a Production
secret.

```bash
sudo install -d -o root -g root -m 0755 /etc/nexora /etc/nexora/env
sudo touch /etc/nexora/env/staging.env
sudo chown root:root /etc/nexora/env/staging.env
sudo chmod 0600 /etc/nexora/env/staging.env
```

Use `/opt/nexora/.env.staging.example` as the field list. Generate each secret
**independently** — do not derive one from another:

```bash
openssl rand -hex 48        # JWT_SECRET
openssl rand -hex 48        # ADMIN_API_TOKEN
openssl rand -hex 48        # ENROLLMENT_SECRET
openssl rand -hex 32        # POSTGRES_PASSWORD
openssl rand -hex 32        # nexora_monitor password
```

Write them into `/etc/nexora/env/staging.env` with an editor (never via a
shell command line — argv is world-readable through `/proc`). Set
`NEXORA_ENV=staging`, `POSTGRES_DB=nexora_staging`,
`POSTGRES_USER=nexora_staging`,
`API_BASE_URL=https://nexora-staging.design.local/api`,
`CORS_ALLOWED_ORIGINS=https://nexora-staging.design.local`,
`NEXORA_HTTP_PORT=80`, `NEXORA_HTTPS_PORT=443`,
`REMOTE_COMMANDS_ENABLED=false`, and the pinned `NEXORA_IMAGE_*` tags.

Notification credentials, if used, must point at staging-only destinations.

Verify nothing leaked into the repo:

```bash
cd /opt/nexora && git status --short        # must still be clean
```

## 8. TLS certificate

Generate the key and CSR **on staging**; the key never leaves this host.

```bash
sudo install -d -o root -g root -m 0755 /etc/nexora/pki /etc/nexora/pki/ca
sudo install -d -o root -g root -m 0700 /etc/nexora/pki/server
sudo openssl req -newkey rsa:2048 -nodes \
  -keyout /etc/nexora/pki/server/nexora-staging.design.local.key \
  -out /tmp/nexora-staging.csr \
  -subj "/CN=nexora-staging.design.local/O=Nexora" \
  -addext "subjectAltName=DNS:nexora-staging.design.local,DNS:nexora-staging,IP:<STAGING_IP>"
sudo chmod 0600 /etc/nexora/pki/server/nexora-staging.design.local.key
```

Carry **only `/tmp/nexora-staging.csr`** to the CA operator.

> **The one Production-host step.** The CA operator signs the CSR with the
> Nexora Internal Root CA on the Production host and returns **only the signed
> certificate**. The CA private key must never leave that host, and
> `/etc/nexora/pki/server/*` must never be copied *from* Production *to*
> staging — that would let staging impersonate Production.

Install the returned cert plus the CA public cert:

```bash
sudo install -o root -g root -m 0644 nexora-staging.design.local.crt \
  /etc/nexora/pki/server/
sudo install -o root -g root -m 0644 nexora-root-ca.crt /etc/nexora/pki/ca/
sudo cp /etc/nexora/pki/ca/nexora-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
openssl x509 -in /etc/nexora/pki/server/nexora-staging.design.local.crt \
  -noout -subject -issuer -enddate -ext subjectAltName
```

Also create the staging downloads root:

```bash
sudo install -d -o root -g root -m 0755 /srv/nexora/staging/downloads
```

## 9. Start the staging stack

`compose.staging.yaml` is already canonicalized for a dedicated VM (80/443,
`/etc/nexora/pki/server`), so no edit is needed — just start it:

```bash
cd /opt/nexora
sudo docker compose --env-file /etc/nexora/env/staging.env \
  -f compose.yaml -f compose.staging.yaml -p nexora-staging up -d
sudo docker compose -p nexora-staging ps
```

Expect `nexora-staging-postgres-1`, `-api-1`, `-web-1`, `-maintenance-1`,
`-notification-worker-1` and a completed `-migrate-1`.

## 10. Verify HTTPS and the API

```bash
curl -sS -o /dev/null -w 'root=%{http_code}\n'    https://nexora-staging.design.local/
curl -sS -o /dev/null -w 'healthz=%{http_code}\n' https://nexora-staging.design.local/api/healthz
```

Both must be `200` **without** `-k` — if you need `-k`, the CA trust or the
SAN is wrong; fix it rather than bypassing it.

## 11. Migrations

The `migrate` service runs automatically as an `up` dependency. Confirm:

```bash
sudo docker compose -p nexora-staging logs migrate --tail 30
sudo docker exec nexora-staging-postgres-1 \
  psql -U nexora_staging -d nexora_staging -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations"
```

Expect the RC's full migration count (Production is currently at 13; an RC
carrying `0013_remote_desktop` will be 14 — confirm against the RC, do not
assume).

## 12. Synthetic staging data

**Synthetic only.** No Production dump, no customer data.

Reuse the PR-05B disposable-customer pattern to create, entirely through the
public API: two organizations, sites, role-differentiated users
(admin / technician / viewer), and scoped enrollment tokens. Then enroll one
or two clearly-labelled test Agents.

```bash
cd /opt/nexora && bash scripts/run-pr05b-onboarding.sh   # pattern reference
```

Verify no real customer identifiers are present:

```bash
sudo docker exec nexora-staging-postgres-1 \
  psql -U nexora_staging -d nexora_staging -tAc \
  "SELECT count(*) FROM nexora_organizations"
```

## 13. Install self-monitoring

Follow [monitoring-least-privilege.md](monitoring-least-privilege.md). In
summary — as root on **staging only**:

```bash
cd /opt/nexora
sudo bash scripts/staging/validate-staging-target.sh        # MUST pass first
sudo bash scripts/monitoring/install-staging-monitoring.sh staging nexora-staging
```

This creates the `nexora-monitor` / `nexora-notify` / `nexora-watch` system
accounts (nologin, no sudo, no docker group), prepares `/opt/nexora-monitor`,
`/etc/nexora-monitor`, `/run/nexora-monitor`, `/var/lib/nexora-monitor`, and
installs the units **masked** with timers **not** enabled.

Create the monitoring DB role and aggregate-only views, and write the
`pgpass` credential (`root:root 0600`) for `LoadCredential=`:

```bash
sudo docker exec -i nexora-staging-postgres-1 \
  psql -U nexora_staging -d nexora_staging < scripts/monitoring/sql/monitor-role.sql
```

Confirm the role is genuinely least-privilege:

```bash
sudo docker exec nexora-staging-postgres-1 psql -U nexora_staging -d nexora_staging -tAc \
 "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname='nexora_monitor'"
```

All five must be `f`.

## 14. Run the runtime validator

```bash
sudo bash scripts/monitoring/validate-staging-runtime.sh
```

Required to pass before any timer is enabled: `MONITOR_EXISTS`,
`MONITOR_NO_DOCKER_GROUP`, `MONITOR_NO_SUDO`, `MONITOR_NO_LOGIN`,
`MONITOR_NO_PRIVILEGED_SUPPLEMENTARY_GROUPS`, `MONITOR_NO_DOCKER_SOCKET`,
`MONITOR_NO_TLS_PRIVATE_KEY`, `MONITOR_NO_APPLICATION_SECRETS`,
`MONITOR_NO_BACKUP_DUMP`, `MONITOR_NO_PII`.

Then unmask only what is needed and run **one controlled pass**:

```bash
sudo systemctl unmask nexora-platform-health.service
sudo systemctl start  nexora-platform-health.service
sudo systemctl status nexora-platform-health.service --no-pager
sudo journalctl -u nexora-platform-health.service -n 50 --no-pager
```

Confirm all 8 domains produce a valid state, the sandbox directives are
actually in force (`systemd-analyze security nexora-platform-health.service`),
and no secret name appears in the journal. A permission failure must surface
as WARNING/CRITICAL — never as HEALTHY.

## 15. Enable the staging timers

Only after §14 fully passes:

```bash
sudo systemctl unmask nexora-container-state.timer nexora-backup-verify.timer \
                      nexora-platform-health.timer
sudo systemctl enable --now nexora-container-state.timer \
                            nexora-backup-verify.timer \
                            nexora-platform-health.timer
systemctl list-timers 'nexora-*' --no-pager
```

Verify each timer's next elapse and confirm the first executions land.

## 16. Begin the 24–48 hour soak

Let it run undisturbed and collect:

total executions · WARNING count · CRITICAL count · false-positive count ·
notifications sent · duplicate notifications · maximum execution duration ·
missed timer runs · stale publisher events · monitoring CPU/RAM/disk usage.

```bash
journalctl -u nexora-platform-health.service --since '24 hours ago' --no-pager \
  | grep -c CRITICAL
systemctl list-timers 'nexora-*' --no-pager
systemd-analyze security nexora-platform-health.service
```

Mid-soak, exercise safe failure injection (stale container-state, stale
backup-state, DB auth failure, stale worker heartbeat, unreachable API, TLS
failure) and confirm each returns to HEALTHY after recovery.

> **Production rollout is a separate stage requiring explicit approval.**
> A clean soak does not authorize promotion.

---

## Rollback

Staging is disposable. To unwind:

```bash
sudo systemctl disable --now 'nexora-*.timer'
sudo systemctl mask nexora-platform-health.service
cd /opt/nexora && sudo docker compose -p nexora-staging down    # add -v to drop data
```

To discard entirely, delete the VM. Nothing on Production is affected at any
point.
