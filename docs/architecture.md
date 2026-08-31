# Nexora architecture

Nexora is split into a browser dashboard, an HTTP API, PostgreSQL persistence,
and a Windows Worker Service. The agent never talks directly to the browser:
all telemetry crosses the API boundary and is stored server-side.

One deployment serves many independent companies. Devices belong to a site,
sites to an organization, and every tenant-scoped read is filtered in SQL from
the caller's memberships — see [multi-tenancy.md](multi-tenancy.md).

The database distinguishes a device endpoint from its installed agent
credential. Device UUID is the durable endpoint identity; human-readable agent
IDs are display identifiers only. Online state is derived from backend receive
time (`last_seen_at`) using configurable thresholds rather than trusting agent
timestamps.