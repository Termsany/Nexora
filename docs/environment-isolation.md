# Environment isolation

How Nexora separates **production**, **staging**, and **local development**,
and why each separation exists.

The short version: before this stage, running `docker compose up` in a
developer checkout *was* a production deployment. Compose project names,
database names, secrets, image builds, and the Agent download directory were
all shared between the customer stack and every developer worktree. This
document describes the audit that found that, the model that replaces it, and
the guards that enforce it.

---

## 1. Audit findings

Findings are against the state of the repository and the running host at the
time of the PR-03 audit.

### P0 — direct production impact possible

**P0-1 — The developer worktree *is* the production deployment.**
`compose.yaml` declares `name: nexora`, and the running customer stack is
Compose project `nexora`, launched from `/home/mustafa/Nexora/compose.yaml`.
Its containers carry
`com.docker.compose.project.working_dir=/home/mustafa/Nexora`. Any developer
running `docker compose up`, `down`, `down -v`, `restart`, or `build` in this
checkout operates directly on the customer stack — including
`down -v`, which would delete `nexora_postgres-data` and with it all customer
data.

**P0-2 — Production images are built from whatever is in the worktree.**
Every service in `compose.yaml` uses `build: context: .`, and the running
production images have no release, revision, or version labels at all — only
`com.docker.compose.project=nexora`. There is no way to tell what source
produced the running production containers, and `docker compose up --build`
(the command the README documents) rebuilds production from the current,
possibly dirty, worktree.

**P0-3 — An uncommitted migration would be applied to production.**
The `migrate` service runs `drizzle-kit migrate` over `lib/db/drizzle/` on
every `compose up`, and `api` depends on it completing successfully. The
working tree currently contains an uncommitted `0013_remote_desktop` migration
and a corresponding `_journal.json` entry. Production has 13 migrations
applied (`0000`–`0012`). A single `docker compose up` in this worktree would
apply Remote Desktop schema to the customer database — a feature explicitly
excluded from RC1.

**P0-4 — Production is running on committed development default secrets.**
The host `.env` defines only `TELEGRAM_*`, `ADMIN_API_TOKEN`, and
`ENROLLMENT_SECRET`. It does **not** define `POSTGRES_PASSWORD` or
`JWT_SECRET`, so `compose.yaml`'s fallbacks apply and production is running
with `nexora-local-password` and `change-this-local-jwt-secret` — literal
values committed to this repository and identical on every developer machine.
Anyone with the repo can forge a production session token.

**P0-4a — The secret validator checks the wrong variables.**
`artifacts/api-server/src/security/config.ts` refuses to start when
`ADMIN_API_TOKEN` or `ENROLLMENT_SECRET` is short or matches an unsafe
pattern. Its `unsafe` regex is:

```
/^(change-this|development|password|secret|nexora-local-password)/i
```

It explicitly names `change-this` and `nexora-local-password` — the two values
production is *actually* running (P0-4) — but those live in `JWT_SECRET` and
the database password, and **neither variable is in the list being checked**.
The guard was written with the right knowledge and applied to the wrong
inputs, which is why P0-4 has gone undetected in a running production system.

Adding `JWT_SECRET` to that list is the correct fix, but it must land
**together with** the secret rotation, not before it: production currently
holds the unsafe value, so tightening the check first would make the next
production container start fail. Sequence: rotate in a maintenance window,
then tighten the validator.

**P0-5 — A production database dump is tracked in git.**
`backups/nexora-pre-task009-20260830T222639Z.dump` (11 MB) is committed.
Customer data is in version control and in every clone.

**P0-6 — Development can overwrite the customer-visible Agent package.**
`./pilot/downloads` is bind-mounted into the running `web` container as
`/usr/share/nginx/downloads` and served at
`https://nexora.design.local/downloads/`. It is an ordinary developer-writable
directory inside the worktree, and `scripts/build-windows-agent-package.sh`
wrote there by default, under the customer-facing filename
`nexora-agent-pilot.zip`. A developer testing an Agent build silently replaced
the package customers download. The directory currently also contains
development/test artifacts (`nexora-agent-task010b-full.zip`,
`nexora-agent-0.3.0-44f52f5.zip`) sitting in customer-visible storage.

### P1 — operational risk

- **P1-1** — No staging environment exists at all. Release candidates have
  nowhere to be validated except production.
- **P1-2** — `drizzle-kit push` (destructive schema diffing, no migration
  history) is documented in the README quickstart and reads whatever
  `DATABASE_URL` is exported, with no guard.
- **P1-3** — `COMPOSE_PROJECT_NAME` left over in a shell silently retargets
  every Compose command, overriding the `name:` field.
- **P1-4** — Test harnesses (`scripts/run-*.sh`) start ad-hoc `postgres`
  containers named `nexora-*` on the default bridge network, published on
  `0.0.0.0`, owned by no Compose project, so they survive every teardown; one
  (`nexora-task010b-test-postgres`) has been running for hours alongside
  production. *Fixed here:* all four harnesses now bind to `127.0.0.1` and
  carry `nexora.environment=development` / `nexora.disposable=true` labels, so
  an orphan can be found and cleaned up. The pre-existing orphan is untouched
  (it may belong to in-flight work).
- **P1-5** — Production, staging, and development all resolve to the same
  hostname and ports; there is no way to tell them apart from a browser.
- **P1-6** — The dev PostgreSQL port collided with
  `scripts/run-api-integration.sh` (both `55432`). Dev now uses `55430`, clear
  of the harness range `55432`/`55435`/`55436`/`55437`.

### P2 — hygiene

- **P2-1** — `.gitignore` covered `.env` but not `.env.*`, so a new
  `.env.production` would have been committable.
- **P2-2** — The README documents `docker compose up --build` as the normal
  way to run the project, with no mention that it targets production.
- **P2-3** — `docs/deployment.md` describes the unauthenticated `/downloads/`
  endpoint as pilot-acceptable but does not note that its backing directory is
  developer-writable.

---

## 2. Environment model

|                     | production                    | staging                              | development                     |
| ------------------- | ----------------------------- | ------------------------------------ | ------------------------------- |
| Compose project     | `nexora-prod`                 | `nexora-staging`                     | `nexora-dev`                    |
| Database            | `nexora_prod`                 | `nexora_staging`                     | `nexora_dev`                    |
| DB volume           | `nexora-prod_postgres-data`   | `nexora-staging_postgres-data`       | `nexora-dev_postgres-data`      |
| Network             | `nexora-prod_default`         | `nexora-staging_default`             | `nexora-dev_default`            |
| Hostname            | `nexora.design.local`         | `nexora-staging.design.local`        | `localhost`                     |
| Ports               | `80` / `443`                  | `80` / `443` (own VM)                | `8080` / `8443`, loopback only  |
| Secrets             | `/etc/nexora/env/production.env` | `/etc/nexora/env/staging.env`     | `.env.development` (disposable) |
| PKI                 | `/etc/nexora/pki/server`      | `/etc/nexora/pki/server` (own VM)    | `.local/dev-pki`                |
| Agent downloads     | `/srv/nexora/production/downloads` | `/srv/nexora/staging/downloads` | `.local/dev-downloads`          |
| Images              | immutable, labelled, pinned   | the same immutable RC images         | built from the worktree         |
| Source bind mounts  | none                          | none                                 | permitted                       |

Postgres is never published to a host port in production or staging. In
development it is bound to `127.0.0.1` only, because local tooling
(`drizzle-kit`, `psql`) needs it and the network does not.

### The legacy identity

The running customer stack still uses the pre-PR-03 identity: project
`nexora`, database `nexora`, volume `nexora_postgres-data`. It is deliberately
**not** renamed by this change — renaming a running Compose project orphans
its containers and detaches its data volume, which is exactly the class of
incident this stage exists to prevent. The cutover to `nexora-prod` is a
data-moving operation (volume copy, database rename, re-issued credentials)
that belongs in a planned maintenance window with a backup taken first.

Until then, `scripts/env/nexora-env.sh` treats **both** identities as
production, so the guards protect the stack that is actually running today,
not only the one that will exist after the cutover.

---

## 3. Using it

Every operation names its environment. There is no default, because the only
safe default would be the one that can damage customers.

```bash
# Local development
cp .env.development.example .env.development && chmod 600 .env.development
scripts/env/nexora-compose.sh development up -d
scripts/env/migrate.sh development
scripts/env/publish-agent-package.sh development

# Staging
scripts/env/nexora-compose.sh staging up -d
scripts/env/migrate.sh staging

# Verify the whole model
scripts/env/validate-isolation.sh
```

### Building a release

```bash
scripts/env/build-release.sh "Nexora First Customer RC1"
```

Refuses a dirty worktree, and labels every image with the release name, commit
SHA, **git tree hash**, build timestamp, and version. The tree hash is the
important one: two commits can share a tree, and a commit SHA alone does not
prove the build used that content.

### Production

Production operations require all three of:

1. an explicit `production` target,
2. `NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION'` typed
   into the interactive shell — it appears in no script, so it cannot be
   satisfied by automation,
3. `NEXORA_RELEASE` plus `NEXORA_IMAGE_{API,WEB,MIGRATE}` naming approved
   immutable tags that already exist on the host.

`production down`, `rm`, `kill`, `stop`, `build`, and `push` are refused
outright by the wrapper; taking the customer stack down is planned maintenance
with a backup first (PR-04). Production migrations additionally require a
clean worktree, an optional `NEXORA_RELEASE_TREE` match, and typing the
database name at a prompt.

---

## 4. How RC1 satisfies build/source isolation

RC1 is `4ddf04ab5e4961a4ddf516b6c3cdd8c9a7b04ad3`, tree
`76a2edf7381766b149c1feabac138ba9e3a357e8`.

**These images have been built and verified.** The build used a clean detached
worktree of the RC1 commit, so the release corresponds to reviewed source
rather than to whatever the developer had open:

```bash
git worktree add --detach /tmp/nexora-rc1 4ddf04ab5e4961a4ddf516b6c3cdd8c9a7b04ad3
NEXORA_BUILD_SOURCE_DIR=/tmp/nexora-rc1 \
  scripts/env/build-release.sh "Nexora First Customer RC1"
git worktree remove /tmp/nexora-rc1
```

Result — `nexora-{api,web,migrate}:nexora-first-customer-rc1-4ddf04ab`, each
carrying:

```
org.nexora.release                 = Nexora First Customer RC1
org.nexora.source.tree             = 76a2edf7381766b149c1feabac138ba9e3a357e8
org.nexora.version                 = 0.3.0
org.opencontainers.image.revision  = 4ddf04ab5e4961a4ddf516b6c3cdd8c9a7b04ad3
org.opencontainers.image.created   = 2026-09-10T20:22:21Z
```

The recorded tree matches RC1's expected tree exactly, so the images are
verifiable by content, not just by tag.

Remaining steps: validate on staging with those exact tags, then deploy the
same tags to production. `compose.prod.yaml` removes `build:` from every
service and sets `pull_policy: never`, and `nexora-compose.sh` refuses any
production image lacking `org.nexora.release`, `org.nexora.source.tree`, and
`org.opencontainers.image.revision` — or whose tree does not match
`NEXORA_RELEASE_TREE`.

Two traps this closes:

- The images running in production today do **not** satisfy this (P0-2) — no
  provenance labels, built from this worktree.
- Pre-existing images tagged `nexora-api:first-customer-rc1` and
  `nexora-web:first-customer-rc1` (built 2026-09-10 22:28) also carry **no
  labels**. They look like an approved release and are not one: nothing ties
  them to a source tree. The production guard now refuses them by name.
  They are superseded by the `nexora-first-customer-rc1-4ddf04ab` tags above
  and should be deleted.

---

## 5. Evidence

`scripts/env/validate-isolation.sh` is the executable version of this
document — 60+ checks, all read-only, safe to run on the production host. It
covers identity separation, rendered compose configuration, guard behaviour
(each guard is invoked in a way that *must* refuse), live Docker state, image
provenance, and secret hygiene.

Beyond configuration checks, the model was exercised for real:

- **The dev stack was actually built and started** as project `nexora-dev`,
  alongside running production. It produced its own volume
  (`nexora-dev_postgres-data`), network (`nexora-dev_default`), and image tags
  (`nexora-dev-api`, distinct image ID from `nexora-api`). Production
  containers, volume, and images were untouched throughout.
- **The P0-3 scenario was reproduced safely.** `docker compose up` applied the
  uncommitted `0013_remote_desktop` migration — to the *dev* database. Dev now
  reports 14 applied migrations and 2 `remote_desktop` tables; production still
  reports 13 and 0. Under the old setup, that migration would have landed on
  customer data.
- **The P0-6 scenario was reproduced safely.** `publish-agent-package.sh
  development` built an Agent package (SHA `6461ef15…`) into
  `.local/dev-downloads`. The customer-visible
  `pilot/downloads/nexora-agent-pilot.zip` was byte-identical before and after
  (SHA `ef021879…`, mtime unchanged). Under the old setup it would have been
  overwritten.
- **Dev data is genuinely separate**: dev has 0 devices, production has 9
  devices across 3 organizations.

## 6. What this stage does not fix

These are real and remain open, because each requires an action outside the
scope of a local, non-production change:

- **P0-4** — production is still running on the committed default
  `JWT_SECRET` and `POSTGRES_PASSWORD`. Rotating them invalidates sessions and
  requires `ALTER ROLE` on the live database: planned maintenance, with a
  backup.
- **P0-5** — `backups/*.dump` is now git-ignored, but the existing tracked
  dump is still in the index and in history. Removing it needs a commit;
  purging it needs a history rewrite.
- **P0-1/P0-2** — the live stack still runs as project `nexora` from this
  worktree with unlabelled images. The guards prevent *new* accidents; the
  cutover to `nexora-prod` on immutable RC1 images is the fix.
- **P1-4** — the stray `nexora-task010b-test-postgres` container is still
  running unowned on the default bridge network.
- Staging DNS (`nexora-staging.design.local`) and the host directories
  `/srv/nexora/{production,staging}/downloads` and `/etc/nexora/pki/server`
  are designed here but not provisioned. Staging now targets a **dedicated
  VMware VM** (see `docs/staging-architecture.md`), so it uses ports 80/443
  and the standard PKI path rather than the former shared-host offsets.
