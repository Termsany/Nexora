/**
 * Cross-tenant isolation suite (Task #008 §AG–§AJ, §AU, §AV).
 *
 * Runs the real Express app over a real PostgreSQL database and drives it with
 * HTTP requests, because the isolation being proved is a property of the
 * routes — their SQL, their scoping and their status codes — not of any helper
 * in isolation.
 *
 * Fixture:
 *   Organization A ── Site A ── Device A (+ metrics, alert, software, service, process)
 *   Organization B ── Site B ── Device B (+ the same)
 *   User A  : ORGANIZATION_ADMIN of A          User B : ORGANIZATION_ADMIN of B
 *   Viewer A: ORGANIZATION_VIEWER of A         Platform: PLATFORM_ADMIN
 *
 * Requires DATABASE_URL to point at a migrated, disposable database.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
import pg from "pg";

// Driven against the built server over real HTTP rather than by importing the
// Express app, so what is tested is the artifact that actually ships.
const baseUrl = process.env.NEXORA_TEST_BASE_URL;
const adminToken = process.env.ADMIN_API_TOKEN;
if (!baseUrl) throw new Error("NEXORA_TEST_BASE_URL is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required to seed fixture users");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ids = {
  orgA: crypto.randomUUID(), orgB: crypto.randomUUID(),
  siteA: crypto.randomUUID(), siteB: crypto.randomUUID(),
  deviceA: crypto.randomUUID(), deviceB: crypto.randomUUID(),
  userA: null, userB: null, viewerA: null, platform: null,
  alertA: crypto.randomUUID(), alertB: crypto.randomUUID(),
};
const PASSWORD = "correct-horse-battery-staple";
const sessions = {};

/** Minimal cookie-aware fetch; `who` selects a signed-in principal. */
async function call(method, path, { who, body, bearer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (who && sessions[who]) {
    headers.Cookie = `nexora_session=${sessions[who].token}; nexora_csrf=${sessions[who].csrf}`;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.Origin = process.env.NEXORA_TEST_ORIGIN ?? "https://nexora.design.local";
      headers["X-CSRF-Token"] = sessions[who].csrf;
    }
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, setCookie: response.headers.get("set-cookie") };
}

async function login(email) {
  const response = await call("POST", "/api/v1/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(response.status, 200, `login failed for ${email}: ${JSON.stringify(response.body)}`);
  const cookie = /nexora_session=([^;]+)/.exec(response.setCookie ?? "");
  assert.ok(cookie, "login did not set a session cookie");
  const csrf = /nexora_csrf=([^;]+)/.exec(response.setCookie ?? "");
  assert.ok(csrf, "login did not set a CSRF cookie");
  return { token: cookie[1], csrf: csrf[1] };
}

/**
 * Creates a fixture account through the real user-administration endpoint using
 * the platform administrative token, which also exercises that path rather than
 * writing a password hash directly.
 */
async function seedUser(body) {
  const created = await call("POST", "/api/v1/admin/users", { bearer: adminToken, body });
  assert.equal(created.status, 201, `could not seed ${body.email}: ${JSON.stringify(created.body)}`);
  return created.body.id;
}

before(async () => {
  const now = new Date();

  await pool.query(
    `INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,'Tenant A','tenant-a-fixture'),($2,'Tenant B','tenant-b-fixture')`,
    [ids.orgA, ids.orgB]);
  await pool.query(
    `INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,'Site A'),($3,$4,'Site B')`,
    [ids.siteA, ids.orgA, ids.siteB, ids.orgB]);
  await pool.query(
    `INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id,last_seen_at,status)
     VALUES ($1,'FIX-A',$2,'ALPHA-WORKSTATION',$3,$4,$5,'ONLINE'),
            ($6,'FIX-B',$7,'SECRET-SERVER-B',$8,$9,$5,'ONLINE')`,
    [ids.deviceA, crypto.randomUUID(), ids.orgA, ids.siteA, now, ids.deviceB, crypto.randomUUID(), ids.orgB, ids.siteB]);

  ids.userA = await seedUser({ email: "a@tenant.test", name: "User A", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: ids.orgA, role: "ORGANIZATION_ADMIN" }] });
  ids.userB = await seedUser({ email: "b@tenant.test", name: "User B", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: ids.orgB, role: "ORGANIZATION_ADMIN" }] });
  ids.viewerA = await seedUser({ email: "viewer@tenant.test", name: "Viewer A", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: ids.orgA, role: "ORGANIZATION_VIEWER" }] });
  ids.platform = await seedUser({ email: "platform@tenant.test", name: "Platform Admin", password: PASSWORD, scope: "PLATFORM", platform_role: "PLATFORM_ADMIN" });

  // Telemetry, alerts and inventory on both sides so every read path has
  // something it could wrongly disclose.
  for (const [device, cpu] of [[ids.deviceA, 11], [ids.deviceB, 77]]) {
    await pool.query(
      `INSERT INTO nexora_device_metrics(device_id,captured_at,received_at,cpu_percent,ram_percent,ram_used_bytes,ram_available_bytes,disk_percent,uptime_seconds)
       VALUES ($1,$2,$2,$3,50,1000,1000,40,3600)`, [device, now, cpu]);
    await pool.query(`INSERT INTO nexora_activity(device_id,event) VALUES ($1,'AGENT_ENROLLED')`, [device]);
  }
  await pool.query(
    `INSERT INTO nexora_alerts(id,organization_id,device_id,type,severity,state,title,summary,dedup_key) VALUES
      ($1,$2,$3,'CPU_HIGH','warning','OPEN','Alpha CPU','Alpha summary',$4),
      ($5,$6,$7,'CPU_HIGH','critical','OPEN','Bravo CPU','Bravo summary',$8)`,
    [ids.alertA, ids.orgA, ids.deviceA, `fixture-a-${ids.alertA}`, ids.alertB, ids.orgB, ids.deviceB, `fixture-b-${ids.alertB}`]);

  const identity = (name) => crypto.createHash("sha256").update(name).digest("hex");
  await pool.query(
    `INSERT INTO nexora_device_software(device_id,software_identity,normalized_name,name,version,publisher,architecture) VALUES
      ($1,$2,'contoso secret suite','Contoso Secret Suite','1.0','Contoso','x64'),
      ($3,$2,'contoso secret suite','Contoso Secret Suite','9.9','Contoso','x64')`,
    [ids.deviceA, identity("contoso secret suite"), ids.deviceB]);
  await pool.query(
    `INSERT INTO nexora_device_services(device_id,service_name,display_name,status,startup_type,first_seen_at,last_seen_at)
     VALUES ($1,'AlphaSvc','Alpha Service','RUNNING','AUTOMATIC',$3,$3),($2,'BravoSvc','Bravo Service','RUNNING','AUTOMATIC',$3,$3)`,
    [ids.deviceA, ids.deviceB, now]);
  await pool.query(
    `INSERT INTO nexora_device_processes_current(device_id,pid,process_name,executable_path,username,cpu_time_seconds,working_set_bytes,started_at,architecture,snapshot_id,last_seen_at)
     VALUES ($1,101,'alpha.exe','C:/alpha.exe','ALPHA\\\\svc',1,1000,$3,'x64',$4,$3),
            ($2,202,'bravo.exe','C:/bravo.exe','BRAVO\\\\svc',1,1000,$3,'x64',$5,$3)`,
    [ids.deviceA, ids.deviceB, now, crypto.randomUUID(), crypto.randomUUID()]);

  sessions.a = await login("a@tenant.test");
  sessions.b = await login("b@tenant.test");
  sessions.viewer = await login("viewer@tenant.test");
  sessions.platform = await login("platform@tenant.test");
});

after(async () => {
  await pool.query("DELETE FROM nexora_alerts WHERE organization_id = ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
  await pool.query("DELETE FROM nexora_devices WHERE organization_id = ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
  await pool.query("DELETE FROM nexora_enrollment_tokens WHERE organization_id = ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
  await pool.query("DELETE FROM nexora_users WHERE id = ANY($1::uuid[])", [[ids.userA, ids.userB, ids.viewerA, ids.platform]]);
  await pool.query("DELETE FROM nexora_sites WHERE organization_id = ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
  await pool.query("DELETE FROM nexora_organizations WHERE id = ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("anonymous requests are refused on every tenant-owned route", async () => {
  for (const path of [
    "/api/v1/devices", `/api/v1/devices/${ids.deviceA}`, `/api/v1/devices/${ids.deviceA}/metrics`,
    "/api/v1/alerts", `/api/v1/alerts/${ids.alertA}`, "/api/v1/dashboard/summary", "/api/v1/dashboard/health",
    "/api/v1/dashboard/alerts", "/api/v1/software", "/api/v1/services", "/api/v1/organizations",
    `/api/v1/devices/${ids.deviceA}/software`, `/api/v1/devices/${ids.deviceA}/services`,
    `/api/v1/devices/${ids.deviceA}/processes`, "/api/v1/admin/enrollment-tokens", "/api/v1/notifications",
  ]) {
    const response = await call("GET", path);
    assert.equal(response.status, 401, `${path} must require authentication`);
  }
});

test("a forged session cookie is rejected", async () => {
  const response = await fetch(`${baseUrl}/api/v1/devices`, {
    headers: { Cookie: `nexora_session=${crypto.randomBytes(32).toString("base64url")}` },
  });
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// §AG — what User A can and cannot reach
// ---------------------------------------------------------------------------

test("User A can read their own device and its telemetry, software and inventory", async () => {
  for (const path of [
    `/api/v1/devices/${ids.deviceA}`, `/api/v1/devices/${ids.deviceA}/metrics`,
    `/api/v1/devices/${ids.deviceA}/monitoring`, `/api/v1/devices/${ids.deviceA}/software`,
    `/api/v1/devices/${ids.deviceA}/software/changes`, `/api/v1/devices/${ids.deviceA}/services`,
    `/api/v1/devices/${ids.deviceA}/service-events`, `/api/v1/devices/${ids.deviceA}/processes`,
    `/api/v1/devices/${ids.deviceA}/processes/summary`,
  ]) {
    const response = await call("GET", path, { who: "a" });
    assert.equal(response.status, 200, `${path} should be readable by its owner`);
  }
  const alert = await call("GET", `/api/v1/alerts/${ids.alertA}`, { who: "a" });
  assert.equal(alert.status, 200);
});

test("User A cannot reach any of Device B by direct ID, and gets 404 not 403", async () => {
  for (const path of [
    `/api/v1/devices/${ids.deviceB}`, `/api/v1/devices/${ids.deviceB}/metrics`,
    `/api/v1/devices/${ids.deviceB}/monitoring`, `/api/v1/devices/${ids.deviceB}/software`,
    `/api/v1/devices/${ids.deviceB}/software/changes`, `/api/v1/devices/${ids.deviceB}/services`,
    `/api/v1/devices/${ids.deviceB}/service-events`, `/api/v1/devices/${ids.deviceB}/processes`,
    `/api/v1/devices/${ids.deviceB}/processes/summary`,
  ]) {
    const response = await call("GET", path, { who: "a" });
    // 404 rather than 403 so a tenant cannot confirm the ID exists at all.
    assert.equal(response.status, 404, `${path} must be hidden from another tenant`);
    assert.ok(!JSON.stringify(response.body ?? "").includes("SECRET-SERVER-B"), `${path} leaked the hostname`);
    assert.ok(!JSON.stringify(response.body ?? "").includes("bravo.exe"), `${path} leaked process data`);
  }
});

test("User A cannot read or acknowledge Organization B's alert", async () => {
  const read = await call("GET", `/api/v1/alerts/${ids.alertB}`, { who: "a" });
  assert.equal(read.status, 404);
  assert.ok(!JSON.stringify(read.body ?? "").includes("Bravo"));

  const ack = await call("POST", `/api/v1/alerts/${ids.alertB}/acknowledge`, { who: "a" });
  assert.equal(ack.status, 404, "acknowledging another tenant's alert must fail");

  const state = await pool.query("SELECT state, acknowledged_by FROM nexora_alerts WHERE id=$1", [ids.alertB]);
  assert.equal(state.rows[0].state, "OPEN", "the alert must remain untouched");
  assert.equal(state.rows[0].acknowledged_by, null);
});

test("the inverse holds for User B", async () => {
  assert.equal((await call("GET", `/api/v1/devices/${ids.deviceB}`, { who: "b" })).status, 200);
  assert.equal((await call("GET", `/api/v1/devices/${ids.deviceA}`, { who: "b" })).status, 404);
  assert.equal((await call("GET", `/api/v1/alerts/${ids.alertA}`, { who: "b" })).status, 404);
  assert.equal((await call("POST", `/api/v1/alerts/${ids.alertA}/acknowledge`, { who: "b" })).status, 404);
});

// ---------------------------------------------------------------------------
// §AH — aggregate and pagination-total isolation
// ---------------------------------------------------------------------------

test("device list and its total count only ever describe the caller's own estate", async () => {
  const a = await call("GET", "/api/v1/devices?page_size=100", { who: "a" });
  assert.equal(a.status, 200);
  const hostnamesA = a.body.items.map((device) => device.hostname);
  assert.deepEqual(hostnamesA, ["ALPHA-WORKSTATION"]);
  assert.equal(a.body.total, 1, "total must not count the other tenant's devices");

  const b = await call("GET", "/api/v1/devices?page_size=100", { who: "b" });
  assert.deepEqual(b.body.items.map((device) => device.hostname), ["SECRET-SERVER-B"]);
  assert.equal(b.body.total, 1);
});

test("dashboard aggregates are isolated", async () => {
  const summaryA = await call("GET", "/api/v1/dashboard/summary", { who: "a" });
  assert.equal(summaryA.body.total_devices, 1);
  // Device B reports 77% CPU; averaging across tenants would show it here.
  assert.ok(summaryA.body.average_cpu < 50, `average_cpu leaked across tenants: ${summaryA.body.average_cpu}`);

  const healthA = await call("GET", "/api/v1/dashboard/health", { who: "a" });
  assert.equal(healthA.body.devices.length, 1);
  assert.equal(healthA.body.devices[0].hostname, "ALPHA-WORKSTATION");
  for (const key of ["highest_cpu", "highest_memory", "highest_disk"]) {
    assert.ok(healthA.body[key].every((row) => row.hostname !== "SECRET-SERVER-B"), `${key} leaked another tenant`);
  }

  const alertsA = await call("GET", "/api/v1/dashboard/alerts", { who: "a" });
  assert.equal(Number(alertsA.body.active_alerts), 1);
  assert.equal(Number(alertsA.body.critical_alerts), 0, "the other tenant's critical alert must not be counted");

  const activityA = await call("GET", "/api/v1/dashboard/activity", { who: "a" });
  assert.ok(activityA.body.every((row) => row.hostname !== "SECRET-SERVER-B"));
});

test("alert list totals are isolated", async () => {
  const a = await call("GET", "/api/v1/alerts?page_size=100", { who: "a" });
  assert.equal(a.body.total, 1);
  assert.deepEqual(a.body.items.map((alert) => alert.title), ["Alpha CPU"]);
});

test("fleet software aggregation reports only the caller's own installations", async () => {
  // Both tenants have the same application at different versions. A fleet-wide
  // count would report two endpoints and expose both versions.
  const a = await call("GET", "/api/v1/software?page_size=100", { who: "a" });
  assert.equal(a.status, 200);
  const suite = a.body.items.find((item) => item.name === "Contoso Secret Suite");
  assert.ok(suite, "the caller's own installation should still be listed");
  assert.equal(suite.installed_endpoints, 1, "endpoint count leaked the other tenant");
  assert.deepEqual(suite.versions.map((version) => version.version), ["1.0"], "version distribution leaked");
  assert.equal(a.body.total, 1);

  const devices = await call("GET", `/api/v1/software/${crypto.createHash("sha256").update("contoso secret suite").digest("hex")}/devices?page_size=100`, { who: "a" });
  assert.equal(devices.body.total, 1);
  assert.deepEqual(devices.body.items.map((row) => row.hostname), ["ALPHA-WORKSTATION"]);
});

test("fleet service catalogue is isolated", async () => {
  const a = await call("GET", "/api/v1/services?page_size=100", { who: "a" });
  assert.equal(a.status, 200);
  assert.ok(a.body.items.every((row) => row.service_name !== "BravoSvc"), "another tenant's service was listed");
  assert.equal(a.body.total, 1);
});

// ---------------------------------------------------------------------------
// §AI — search
// ---------------------------------------------------------------------------

test("searching for another tenant's hostname returns nothing", async () => {
  const search = await call("GET", "/api/v1/devices?search=SECRET-SERVER-B&page_size=100", { who: "a" });
  assert.equal(search.status, 200);
  assert.equal(search.body.items.length, 0);
  assert.equal(search.body.total, 0, "even the total must not confirm the device exists");
});

test("software and service search are scoped", async () => {
  const software = await call("GET", "/api/v1/software?search=Contoso&page_size=100", { who: "a" });
  assert.equal(software.body.items[0]?.installed_endpoints, 1);
  const services = await call("GET", "/api/v1/services?search=Bravo&page_size=100", { who: "a" });
  assert.equal(services.body.total, 0);
});

test("organization search cannot discover another tenant", async () => {
  const response = await call("GET", "/api/v1/organizations?search=Tenant&page_size=100", { who: "a" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((organization) => organization.name), ["Tenant A"]);
  assert.equal(response.body.total, 1);
});

// ---------------------------------------------------------------------------
// §AJ — filtering happens before pagination
// ---------------------------------------------------------------------------

test("pagination cannot page into another tenant's rows", async () => {
  // Page 2 of a one-device tenant must be empty, not the other tenant's device
  // shifted into view by a global query that filtered after LIMIT/OFFSET.
  const page2 = await call("GET", "/api/v1/devices?page=2&page_size=1", { who: "a" });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.items.length, 0);
  assert.equal(page2.body.total, 1);

  const alerts2 = await call("GET", "/api/v1/alerts?page=2&page_size=1", { who: "a" });
  assert.equal(alerts2.body.items.length, 0);
  assert.equal(alerts2.body.total, 1);
});

test("a requested organization_id the caller has no membership in is refused", async () => {
  for (const path of [
    `/api/v1/devices?organization_id=${ids.orgB}`,
    `/api/v1/alerts?organization_id=${ids.orgB}`,
    `/api/v1/software?organization_id=${ids.orgB}`,
    `/api/v1/services?organization_id=${ids.orgB}`,
    `/api/v1/dashboard/summary?organization_id=${ids.orgB}`,
    `/api/v1/dashboard/health?organization_id=${ids.orgB}`,
  ]) {
    const response = await call("GET", path, { who: "a" });
    assert.equal(response.status, 403, `${path} must refuse an unauthorized organization filter`);
  }
});

// ---------------------------------------------------------------------------
// §T/§U/§AD — organizations, sites and memberships
// ---------------------------------------------------------------------------

test("User A cannot read, update or enumerate Organization B", async () => {
  assert.equal((await call("GET", `/api/v1/organizations/${ids.orgB}`, { who: "a" })).status, 404);
  assert.equal((await call("PATCH", `/api/v1/organizations/${ids.orgB}`, { who: "a", body: { name: "Owned" } })).status, 404);
  assert.equal((await call("GET", `/api/v1/organizations/${ids.orgB}/sites`, { who: "a" })).status, 404);
  assert.equal((await call("GET", `/api/v1/organizations/${ids.orgB}/members`, { who: "a" })).status, 404);
  const name = await pool.query("SELECT name FROM nexora_organizations WHERE id=$1", [ids.orgB]);
  assert.equal(name.rows[0].name, "Tenant B");
});

test("User A cannot create a site inside Organization B, nor read Site B", async () => {
  const created = await call("POST", `/api/v1/organizations/${ids.orgB}/sites`, { who: "a", body: { name: "Intruder Site" } });
  assert.equal(created.status, 404);
  assert.equal((await call("GET", `/api/v1/sites/${ids.siteB}`, { who: "a" })).status, 404);
  assert.equal((await call("PATCH", `/api/v1/sites/${ids.siteB}`, { who: "a", body: { name: "Renamed" } })).status, 404);
  const sites = await pool.query("SELECT count(*)::int total FROM nexora_sites WHERE organization_id=$1", [ids.orgB]);
  assert.equal(sites.rows[0].total, 1);
});

test("an organization admin cannot create organizations or manage users", async () => {
  assert.equal((await call("POST", "/api/v1/organizations", { who: "a", body: { name: "Escalated", slug: "escalated-fixture" } })).status, 403);
  assert.equal((await call("GET", "/api/v1/admin/users", { who: "a" })).status, 403);
  assert.equal((await call("POST", "/api/v1/admin/users", { who: "a", body: { email: "x@tenant.test", name: "X", password: "a-long-enough-password", scope: "PLATFORM", platform_role: "PLATFORM_SUPER_ADMIN" } })).status, 403);
});

test("an organization admin cannot add a member to another tenant", async () => {
  const response = await call("POST", `/api/v1/organizations/${ids.orgB}/members`, { who: "a", body: { user_id: ids.userA, role: "ORGANIZATION_ADMIN" } });
  assert.equal(response.status, 404);
  const memberships = await pool.query("SELECT count(*)::int total FROM nexora_organization_memberships WHERE organization_id=$1", [ids.orgB]);
  assert.equal(memberships.rows[0].total, 1);
});

test("an organization admin cannot change their own role or suspend their tenant", async () => {
  assert.equal((await call("PATCH", `/api/v1/organizations/${ids.orgA}/members/${ids.userA}`, { who: "a", body: { role: "ORGANIZATION_VIEWER" } })).status, 403);
  assert.equal((await call("DELETE", `/api/v1/organizations/${ids.orgA}/members/${ids.userA}`, { who: "a" })).status, 403);
  const suspend = await call("PATCH", `/api/v1/organizations/${ids.orgA}`, { who: "a", body: { status: "SUSPENDED" } });
  assert.equal(suspend.status, 403);
  const status = await pool.query("SELECT status FROM nexora_organizations WHERE id=$1", [ids.orgA]);
  assert.equal(status.rows[0].status, "ACTIVE");
});

test("a viewer is read-only within their own organization", async () => {
  assert.equal((await call("GET", `/api/v1/devices/${ids.deviceA}`, { who: "viewer" })).status, 200);
  assert.equal((await call("POST", `/api/v1/alerts/${ids.alertA}/acknowledge`, { who: "viewer" })).status, 403);
  assert.equal((await call("POST", `/api/v1/organizations/${ids.orgA}/sites`, { who: "viewer", body: { name: "Viewer Site" } })).status, 403);
  assert.equal((await call("PATCH", `/api/v1/devices/${ids.deviceA}/site`, { who: "viewer", body: { site_id: ids.siteA } })).status, 403);
  assert.equal((await call("GET", "/api/v1/admin/enrollment-tokens", { who: "viewer" })).status, 403);
});

// ---------------------------------------------------------------------------
// §AV — site ownership
// ---------------------------------------------------------------------------

test("a device cannot be assigned to another organization's site", async () => {
  const response = await call("PATCH", `/api/v1/devices/${ids.deviceA}/site`, { who: "a", body: { site_id: ids.siteB } });
  assert.equal(response.status, 422, "cross-tenant site assignment must be rejected");
  const row = await pool.query("SELECT site_id FROM nexora_devices WHERE id=$1", [ids.deviceA]);
  assert.equal(row.rows[0].site_id, ids.siteA, "the assignment must not have been written");
});

test("even a platform administrator cannot place a device in another tenant's site", async () => {
  const response = await call("PATCH", `/api/v1/devices/${ids.deviceA}/site`, { who: "platform", body: { site_id: ids.siteB } });
  assert.equal(response.status, 422);
});

test("the database itself refuses a cross-tenant site assignment", async () => {
  // Proves the guard is not only in the route: the composite foreign key makes
  // the row unrepresentable even for direct SQL.
  await assert.rejects(
    () => pool.query("UPDATE nexora_devices SET site_id=$1 WHERE id=$2", [ids.siteB, ids.deviceA]),
    /nexora_devices_site_organization_fk/);
});

test("a legitimate same-organization site assignment succeeds", async () => {
  const response = await call("PATCH", `/api/v1/devices/${ids.deviceA}/site`, { who: "a", body: { site_id: ids.siteA } });
  assert.equal(response.status, 200);
  assert.equal(response.body.site_id, ids.siteA);
});

test("device organization cannot be changed through the device APIs", async () => {
  // The site endpoint is the only device-ownership mutation there is, and it
  // ignores anything but site_id.
  await call("PATCH", `/api/v1/devices/${ids.deviceA}/site`, { who: "platform", body: { site_id: ids.siteA, organization_id: ids.orgB } });
  const row = await pool.query("SELECT organization_id FROM nexora_devices WHERE id=$1", [ids.deviceA]);
  assert.equal(row.rows[0].organization_id, ids.orgA, "device tenancy must be immutable here");
});

// ---------------------------------------------------------------------------
// §G/§AU — enrollment
// ---------------------------------------------------------------------------

test("User A cannot mint an enrollment token for Organization B", async () => {
  const response = await call("POST", "/api/v1/admin/enrollment-tokens", {
    who: "a",
    body: { name: "cross-tenant", organization_id: ids.orgB, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_uses: 1 },
  });
  assert.equal(response.status, 404);
  const tokens = await pool.query("SELECT count(*)::int total FROM nexora_enrollment_tokens WHERE organization_id=$1", [ids.orgB]);
  assert.equal(tokens.rows[0].total, 0);
});

test("enrollment token listing is tenant-scoped and never returns the secret", async () => {
  const created = await call("POST", "/api/v1/admin/enrollment-tokens", {
    who: "a",
    body: { name: "tenant-a-token", organization_id: ids.orgA, site_id: ids.siteA, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_uses: 1 },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token, "the raw token is returned exactly once, at creation");

  const listA = await call("GET", "/api/v1/admin/enrollment-tokens", { who: "a" });
  assert.equal(listA.body.length, 1);
  assert.equal(listA.body[0].token, undefined, "the raw token must never be listed");
  assert.equal(listA.body[0].token_hash, undefined, "the token hash must never be exposed");

  const listB = await call("GET", "/api/v1/admin/enrollment-tokens", { who: "b" });
  assert.equal(listB.body.length, 0, "another tenant's tokens must not be visible");
});

test("an agent cannot choose its own organization or site at enrollment", async () => {
  const created = await call("POST", "/api/v1/admin/enrollment-tokens", {
    who: "a",
    body: { name: "attack-token", organization_id: ids.orgA, site_id: ids.siteA, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_uses: 1 },
  });
  assert.equal(created.status, 201);

  const deviceUuid = crypto.randomUUID();
  // The payload claims Organization B and Site B. Both must be ignored: the
  // server reads the tenant from the consumed token alone.
  const enrolled = await call("POST", "/api/v1/agents/enroll", {
    body: {
      enrollment_token: created.body.token,
      device_uuid: deviceUuid,
      hostname: "ATTACKER-PC",
      agent_version: "0.2.0",
      machine_guid_hash: crypto.createHash("sha256").update(deviceUuid).digest("hex"),
      organization_id: ids.orgB,
      organization: "Tenant B",
      site_id: ids.siteB,
    },
  });
  assert.equal(enrolled.status, 201);

  const row = await pool.query("SELECT organization_id, site_id FROM nexora_devices WHERE device_uuid=$1", [deviceUuid]);
  assert.equal(row.rows[0].organization_id, ids.orgA, "the device must land in the token's organization");
  assert.equal(row.rows[0].site_id, ids.siteA, "the device must land in the token's site");

  // And it must be invisible to the tenant it tried to claim.
  const seenByB = await call("GET", "/api/v1/devices?search=ATTACKER-PC&page_size=100", { who: "b" });
  assert.equal(seenByB.body.total, 0);
  const seenByA = await call("GET", "/api/v1/devices?search=ATTACKER-PC&page_size=100", { who: "a" });
  assert.equal(seenByA.body.total, 1);
});

test("an enrolled agent's own credential still drives telemetry, and its tenant follows the device", async () => {
  const created = await call("POST", "/api/v1/admin/enrollment-tokens", {
    who: "a",
    body: { name: "agent-compat", organization_id: ids.orgA, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_uses: 1 },
  });
  const deviceUuid = crypto.randomUUID();
  const enrolled = await call("POST", "/api/v1/agents/enroll", {
    body: {
      enrollment_token: created.body.token, device_uuid: deviceUuid, hostname: "COMPAT-PC",
      agent_version: "0.2.0", machine_guid_hash: crypto.createHash("sha256").update(deviceUuid).digest("hex"),
    },
  });
  assert.equal(enrolled.status, 201);
  const agentToken = enrolled.body.agent_token;

  // The agent authenticates with its own bearer token and sends no tenant of
  // any kind; ownership is resolved from the device it belongs to (§H).
  const heartbeat = await call("POST", "/api/v1/agents/heartbeat", { bearer: agentToken, body: { agent_version: "0.2.0", uptime_seconds: 60, logged_in_user: "compat" } });
  assert.equal(heartbeat.status, 204);
  const metrics = await call("POST", "/api/v1/agents/metrics", {
    bearer: agentToken,
    body: { captured_at: new Date().toISOString(), cpu_percent: 5, ram_percent: 5, ram_used_bytes: 1000, ram_available_bytes: 1000, disk_percent: 5, uptime_seconds: 60 },
  });
  assert.equal(metrics.status, 204);

  const owner = await pool.query("SELECT organization_id FROM nexora_devices WHERE device_uuid=$1", [deviceUuid]);
  assert.equal(owner.rows[0].organization_id, ids.orgA);

  // A stolen agent credential is still only an agent credential: it opens no
  // console route at all.
  assert.equal((await call("GET", "/api/v1/devices", { bearer: agentToken })).status, 401);
  assert.equal((await call("GET", "/api/v1/organizations", { bearer: agentToken })).status, 401);
});

test("a suspended organization accepts no new enrollment", async () => {
  const created = await call("POST", "/api/v1/admin/enrollment-tokens", {
    who: "platform",
    body: { name: "suspend-token", organization_id: ids.orgB, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_uses: 5 },
  });
  assert.equal(created.status, 201);
  await pool.query("UPDATE nexora_organizations SET status='SUSPENDED' WHERE id=$1", [ids.orgB]);
  try {
    const deviceUuid = crypto.randomUUID();
    const enrolled = await call("POST", "/api/v1/agents/enroll", {
      body: {
        enrollment_token: created.body.token, device_uuid: deviceUuid, hostname: "SUSPENDED-PC",
        agent_version: "0.2.0", machine_guid_hash: crypto.createHash("sha256").update(deviceUuid).digest("hex"),
      },
    });
    assert.equal(enrolled.status, 403);

    // Existing agents keep reporting: telemetry ingestion is unaffected by
    // suspension, so platform operators retain monitoring visibility.
    const metrics = await pool.query("SELECT count(*)::int total FROM nexora_device_metrics WHERE device_id=$1", [ids.deviceB]);
    assert.ok(metrics.rows[0].total > 0);
  } finally {
    await pool.query("UPDATE nexora_organizations SET status='ACTIVE' WHERE id=$1", [ids.orgB]);
  }
});

test("an organization user loses access while their organization is suspended", async () => {
  await pool.query("UPDATE nexora_organizations SET status='SUSPENDED' WHERE id=$1", [ids.orgB]);
  try {
    // Suspension removes every membership from the user's context, so they hold
    // no capability anywhere and are refused outright rather than shown an empty
    // list — the default-deny outcome, and a clearer answer than "you may look
    // at nothing".
    const devices = await call("GET", "/api/v1/devices?page_size=100", { who: "b" });
    assert.equal(devices.status, 403);
    assert.equal((await call("GET", `/api/v1/devices/${ids.deviceB}`, { who: "b" })).status, 403);
    assert.equal((await call("GET", `/api/v1/organizations/${ids.orgB}`, { who: "b" })).status, 404);

    // A platform administrator can still inspect the organization.
    assert.equal((await call("GET", `/api/v1/organizations/${ids.orgB}`, { who: "platform" })).status, 200);
    assert.equal((await call("GET", `/api/v1/devices/${ids.deviceB}`, { who: "platform" })).status, 200);
  } finally {
    await pool.query("UPDATE nexora_organizations SET status='ACTIVE' WHERE id=$1", [ids.orgB]);
  }
});

// ---------------------------------------------------------------------------
// Platform access and notifications
// ---------------------------------------------------------------------------

test("a platform administrator sees across tenants and can narrow by organization", async () => {
  const all = await call("GET", "/api/v1/devices?page_size=100", { who: "platform" });
  const hostnames = all.body.items.map((device) => device.hostname);
  assert.ok(hostnames.includes("ALPHA-WORKSTATION") && hostnames.includes("SECRET-SERVER-B"));

  const narrowed = await call("GET", `/api/v1/devices?organization_id=${ids.orgB}&page_size=100`, { who: "platform" });
  assert.deepEqual(narrowed.body.items.map((device) => device.hostname), ["SECRET-SERVER-B"]);
});

test("notification history is tenant-scoped and platform test deliveries stay platform-only", async () => {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO nexora_notifications(id,organization_id,channel,destination,event_type,dedup_key,payload)
     VALUES ($1,$2,'webhook','https://example.test/hook','ALERT_CREATED',$3,'{}'::jsonb),
            ($4,NULL,'webhook','https://example.test/hook','TEST',$5,'{}'::jsonb)`,
    [id, ids.orgB, `fixture-b-${id}`, crypto.randomUUID(), `fixture-test-${id}`]);

  const a = await call("GET", "/api/v1/notifications?page_size=100", { who: "a" });
  assert.equal(a.status, 200);
  assert.equal(a.body.total, 0, "another tenant's deliveries and platform tests must both be hidden");

  const bList = await call("GET", "/api/v1/notifications?page_size=100", { who: "b" });
  assert.equal(bList.body.total, 1, "the owning tenant sees its own delivery but not the platform test");

  assert.equal((await call("GET", "/api/v1/admin/notification-channels", { who: "a" })).status, 403);
  await pool.query("DELETE FROM nexora_notifications WHERE dedup_key LIKE $1", [`fixture-%${id}`]);
});

test("the session identity endpoint reveals only the caller's own organizations", async () => {
  const me = await call("GET", "/api/v1/auth/me", { who: "a" });
  assert.equal(me.status, 200);
  assert.equal(me.body.platform_access, false);
  assert.deepEqual(me.body.organizations.map((organization) => organization.name), ["Tenant A"]);
  assert.equal(me.body.organizations[0].role, "ORGANIZATION_ADMIN");
  assert.equal(me.body.user.email, "a@tenant.test");
});

test("logout revokes the session immediately", async () => {
  const cookie = await login("viewer@tenant.test");
  const before = await fetch(`${baseUrl}/api/v1/devices`, {
    headers: { Cookie: `nexora_session=${cookie.token}; nexora_csrf=${cookie.csrf}` },
  });
  assert.equal(before.status, 200);
  await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `nexora_session=${cookie.token}; nexora_csrf=${cookie.csrf}`,
      Origin: process.env.NEXORA_TEST_ORIGIN ?? "https://nexora.design.local",
      "X-CSRF-Token": cookie.csrf,
    },
  });
  const after = await fetch(`${baseUrl}/api/v1/devices`, {
    headers: { Cookie: `nexora_session=${cookie.token}; nexora_csrf=${cookie.csrf}` },
  });
  assert.equal(after.status, 401);
});
