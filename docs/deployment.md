# Deployment

The API and dashboard are portable Node services in this development
workspace, while the platform contract remains container-friendly. A
production deployment should provide PostgreSQL, set environment variables
from a secret manager, terminate TLS at the edge, and expose a stable DNS name
to agents. Moving between a generic Docker host, AWS, or Azure should require
infrastructure configuration and database migration, not source changes.

## TLS edge

The `web` container (Nginx) terminates TLS directly — no separate reverse
proxy layer. It listens on `80` (redirects to HTTPS, plus a `/healthz`
liveness path used only by the Docker healthcheck) and `443` (serves the
dashboard and proxies `/api/` to the internal `api` service). Only `80` and
`443` are published externally; `api` (3001) and `postgres` (5432) remain on
the internal Docker network only.

Certificate and key material is **not** baked into any Docker image or
stored in the repository. It lives on the host at `/etc/nexora/pki/` and is
bind-mounted read-only into the `web` container
(`/etc/nexora/pki/server:/etc/nexora/pki/server:ro`), so it survives image
rebuilds, container recreation, and host reboots. This is portable to any
Docker host — on AWS/Azure, replace the host bind mount with the platform's
equivalent (an EBS/Azure Disk-backed path, a secret volume, or an external
load balancer terminating TLS instead, in which case this container's `443`
listener would simply not be exposed).

## Certificate backup

At minimum, back up these four files, all under `/etc/nexora/pki/`:

```text
ca/nexora-root-ca.crt      — Root CA public certificate (not secret)
ca/nexora-root-ca.key      — Root CA private key (SECURITY-CRITICAL)
server/nexora.design.local.crt  — server certificate (not secret)
server/nexora.design.local.key  — server private key (secret)
```

- The **Root CA private key** (`nexora-root-ca.key`) is the most sensitive
  file in this deployment. Anyone holding it can mint a certificate for any
  hostname that every Windows machine trusting this CA will accept
  silently. It must never be copied to Windows clients, committed to git,
  or included in routine/unencrypted application backups. If it is lost,
  it cannot be recovered — a new Root CA must be generated, a new server
  certificate issued, and the new Root CA re-distributed and re-trusted on
  every Windows machine that previously trusted the old one. If it is
  suspected to be compromised, treat this the same way: rotate the Root CA
  and re-distribute trust.
- The **server private key** is lower-impact (it can only impersonate
  `nexora.design.local`, and can be reissued from the existing Root CA
  without any client-side trust changes) but should still be treated as a
  secret, not committed to git, and included only in access-controlled
  backups.
- The two `.crt` files are public and may be freely copied/distributed
  (the Root CA `.crt` is specifically meant to be imported on client
  machines — see `docs/windows-internal-ca-trust.md`).
- File permissions on the host restrict both `.key` files to `root`-only
  read access (`chmod 600`); any backup mechanism must preserve this or
  store them in an equivalently access-controlled location (encrypted
  backup target, secrets manager, etc.), not a general-purpose file share.

## Windows Agent package distribution

The Agent pilot package is served as a static, unauthenticated HTTPS
download at `/downloads/nexora-agent-pilot.zip` (built by
`scripts/build-windows-agent-package.sh`, host directory
`pilot/downloads/`, bind-mounted read-only into `web` — never baked into
the image, so a new Agent build can be published without rebuilding the
web image).

**This is acceptable for the current internal Pilot only**, on the
assumption that Nexora is reachable exclusively from the trusted internal
network (no port-forwarding, no public exposure of `443`/`80`). The
package contains no secrets (see `docs/windows-internal-ca-trust.md` for
what is and isn't included), but an unauthenticated download endpoint is
not an acceptable long-term distribution model once Nexora is reachable
from outside a fully trusted network, or once there are multiple Agent
versions/environments to manage.

For production, replace this with one of:

- an authenticated download gated behind the Administration session/token,
- a short-lived signed download URL generated per request,
- a dedicated release-artifact service, or
- object storage (S3/Azure Blob) with access-controlled, time-limited URLs.

None of that is implemented yet — this is a deliberately deferred decision,
not an oversight.