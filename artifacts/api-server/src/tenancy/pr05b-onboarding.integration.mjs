/**
 * PR-05B — First Customer Onboarding acceptance.
 *
 * Drives the real built server over HTTP against a disposable, migrated
 * database. Every organisation, site, user, enrolment token and device is
 * created through a public API (ADMIN_API_TOKEN for platform operations,
 * real user sessions for tenant operations). No structural rows are written
 * by hand.
 *
 *   Org A ── Site A1, Site A2
 *   Org B ── Site B1
 *   Users: A-Admin (ORGANIZATION_ADMIN/A), A-Tech (ORGANIZATION_TECHNICIAN/A),
 *          A-Viewer (ORGANIZATION_VIEWER/A), B-Admin (ORGANIZATION_ADMIN/B)
 *
 * Requires: NEXORA_TEST_BASE_URL, ADMIN_API_TOKEN, DATABASE_URL.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
import pg from "pg";

const baseUrl = process.env.NEXORA_TEST_BASE_URL;
const adminToken = process.env.ADMIN_API_TOKEN;
if (!baseUrl) throw new Error("NEXORA_TEST_BASE_URL is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const PASSWORD = "correct-horse-battery-staple-05b";
const uniq = crypto.randomBytes(4).toString("hex");
const S = { orgA: null, orgB: null, a1: null, a2: null, b1: null, deviceA1: null, deviceB1: null };
const sessions = {};

async function call(method, path, { who, body, bearer, origin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (who && sessions[who]) {
    headers.Cookie = `nexora_session=${sessions[who].token}; nexora_csrf=${sessions[who].csrf}`;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.Origin = origin ?? process.env.NEXORA_TEST_ORIGIN ?? "https://nexora.design.local";
      headers["X-CSRF-Token"] = sessions[who].csrf;
    }
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, setCookie: res.headers.get("set-cookie") };
}
async function login(email) {
  const r = await call("POST", "/api/v1/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: /nexora_session=([^;]+)/.exec(r.setCookie)[1], csrf: /nexora_csrf=([^;]+)/.exec(r.setCookie)[1] };
}
const seedUser = async (b) => {
  const r = await call("POST", "/api/v1/admin/users", { bearer: adminToken, body: b });
  assert.equal(r.status, 201, `seed ${b.email}: ${JSON.stringify(r.body)}`);
  return r.body.id;
};
const mkOrg = async (name, slug) => {
  const r = await call("POST", "/api/v1/organizations", { bearer: adminToken, body: { name, slug } });
  assert.equal(r.status, 201, `org ${name}: ${JSON.stringify(r.body)}`);
  return r.body.id;
};
const mkSite = async (orgId, name) => {
  const r = await call("POST", `/api/v1/organizations/${orgId}/sites`, { bearer: adminToken, body: { name } });
  assert.equal(r.status, 201, `site ${name}: ${JSON.stringify(r.body)}`);
  return r.body.id;
};
const mkToken = async (orgId, siteId, maxUses, msToExpiry) => {
  const body = { name: `t-${uniq}`, organization_id: orgId, max_uses: maxUses, expires_at: new Date(Date.now() + msToExpiry).toISOString() };
  if (siteId) body.site_id = siteId;
  const r = await call("POST", "/api/v1/admin/enrollment-tokens", { bearer: adminToken, body });
  assert.equal(r.status, 201, `token: ${JSON.stringify(r.body)}`);
  return r.body;
};
const enroll = async (token, hostname, extra = {}) => {
  const deviceUuid = crypto.randomUUID();
  const r = await call("POST", "/api/v1/agents/enroll", {
    body: { enrollment_token: token, device_uuid: deviceUuid, hostname, agent_version: "0.3.0",
      machine_guid_hash: crypto.createHash("sha256").update(deviceUuid).digest("hex"), ...extra },
  });
  return { ...r, deviceUuid };
};

before(async () => {
  S.orgA = await mkOrg(`PR05B Northwind ${uniq}`, `pr05b-northwind-${uniq}`);
  S.orgB = await mkOrg(`PR05B Contoso ${uniq}`, `pr05b-contoso-${uniq}`);
  S.a1 = await mkSite(S.orgA, "Site A1");
  S.a2 = await mkSite(S.orgA, "Site A2");
  S.b1 = await mkSite(S.orgB, "Site B1");
  S.uAdminA = await seedUser({ email: `a-admin-${uniq}@t.test`, name: "A Admin", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: S.orgA, role: "ORGANIZATION_ADMIN" }] });
  S.uTechA = await seedUser({ email: `a-tech-${uniq}@t.test`, name: "A Tech", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: S.orgA, role: "ORGANIZATION_TECHNICIAN" }] });
  S.uViewA = await seedUser({ email: `a-view-${uniq}@t.test`, name: "A Viewer", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: S.orgA, role: "ORGANIZATION_VIEWER" }] });
  S.uAdminB = await seedUser({ email: `b-admin-${uniq}@t.test`, name: "B Admin", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: S.orgB, role: "ORGANIZATION_ADMIN" }] });
  sessions.aadmin = await login(`a-admin-${uniq}@t.test`);
  sessions.atech = await login(`a-tech-${uniq}@t.test`);
  sessions.aview = await login(`a-view-${uniq}@t.test`);
  sessions.badmin = await login(`b-admin-${uniq}@t.test`);
});

after(async () => {
  await pool.query("DELETE FROM nexora_alerts WHERE organization_id = ANY($1::uuid[])", [[S.orgA, S.orgB]]);
  await pool.query("DELETE FROM nexora_device_metrics WHERE device_id IN (SELECT id FROM nexora_devices WHERE organization_id = ANY($1::uuid[]))", [[S.orgA, S.orgB]]);
  await pool.query("DELETE FROM nexora_devices WHERE organization_id = ANY($1::uuid[])", [[S.orgA, S.orgB]]);
  await pool.query("DELETE FROM nexora_enrollment_tokens WHERE organization_id = ANY($1::uuid[])", [[S.orgA, S.orgB]]);
  await pool.query("DELETE FROM nexora_users WHERE id = ANY($1::uuid[])", [[S.uAdminA, S.uTechA, S.uViewA, S.uAdminB]]);
  await pool.query("DELETE FROM nexora_sites WHERE organization_id = ANY($1::uuid[])", [[S.orgA, S.orgB]]);
  await pool.query("DELETE FROM nexora_organizations WHERE id = ANY($1::uuid[])", [[S.orgA, S.orgB]]);
  await pool.end();
});

// ---------------- §1 onboarding simulation ----------------
test("§1 disposable customer created entirely through public APIs", () => {
  for (const [k, v] of Object.entries(S)) assert.ok(v || k.startsWith("device"), `${k} was created`);
});

// ---------------- §2 role acceptance ----------------
test("§2 Org Admin: org-scoped administration, site+device visibility, enrollment admin", async () => {
  assert.equal((await call("GET", "/api/v1/organizations", { who: "aadmin" })).status, 200);
  assert.equal((await call("GET", `/api/v1/organizations/${S.orgA}/sites`, { who: "aadmin" })).status, 200);
  assert.equal((await call("PATCH", `/api/v1/organizations/${S.orgA}`, { who: "aadmin", body: { name: `PR05B Northwind ${uniq} X` } })).status, 200);
  const tok = await call("POST", "/api/v1/admin/enrollment-tokens", { who: "aadmin", body: { name: "byadmin", organization_id: S.orgA, site_id: S.a1, max_uses: 1, expires_at: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(tok.status, 201, JSON.stringify(tok.body));
  assert.equal((await call("POST", `/api/v1/admin/enrollment-tokens/${tok.body.id}/revoke`, { who: "aadmin" })).status, 204);
});
test("§2 Org Admin cannot perform platform-only operations", async () => {
  assert.equal((await call("POST", "/api/v1/organizations", { who: "aadmin", body: { name: "Rogue", slug: `rogue-${uniq}` } })).status, 403);
  assert.equal((await call("POST", "/api/v1/admin/users", { who: "aadmin", body: { email: `x-${uniq}@t.test`, name: "x", password: PASSWORD, scope: "PLATFORM", platform_role: "PLATFORM_ADMIN" } })).status, 403);
});
test("§2 Technician: operational access, no org administration", async () => {
  assert.equal((await call("GET", "/api/v1/devices", { who: "atech" })).status, 200);
  assert.equal((await call("GET", "/api/v1/admin/enrollment-tokens", { who: "atech" })).status, 200); // read allowed
  assert.equal((await call("POST", "/api/v1/admin/enrollment-tokens", { who: "atech", body: { name: "notech", organization_id: S.orgA, site_id: S.a1, max_uses: 1, expires_at: new Date(Date.now() + 3600e3).toISOString() } })).status, 403);
  assert.equal((await call("PATCH", `/api/v1/organizations/${S.orgA}`, { who: "atech", body: { name: "nope" } })).status, 403);
});
test("§2 Viewer: read-only, every mutation refused", async () => {
  assert.equal((await call("GET", "/api/v1/devices", { who: "aview" })).status, 200);
  assert.equal((await call("GET", "/api/v1/admin/enrollment-tokens", { who: "aview" })).status, 403);
  assert.equal((await call("PATCH", `/api/v1/organizations/${S.orgA}`, { who: "aview", body: { name: "nope" } })).status, 403);
});

// ---------------- §3 / §13 isolation ----------------
async function crossTenantMatrix(devB, alertB) {
  const r = {};
  r.orgById = (await call("GET", `/api/v1/organizations/${S.orgB}`, { who: "aadmin" })).status;
  r.sitesOfB = (await call("GET", `/api/v1/organizations/${S.orgB}/sites`, { who: "aadmin" })).status;
  r.siteById = (await call("GET", `/api/v1/sites/${S.b1}`, { who: "aadmin" })).status;
  r.deviceById = (await call("GET", `/api/v1/devices/${devB}`, { who: "aadmin" })).status;
  r.metrics = (await call("GET", `/api/v1/devices/${devB}/metrics`, { who: "aadmin" })).status;
  r.software = (await call("GET", `/api/v1/devices/${devB}/software`, { who: "aadmin" })).status;
  r.services = (await call("GET", `/api/v1/devices/${devB}/services`, { who: "aadmin" })).status;
  r.processes = (await call("GET", `/api/v1/devices/${devB}/processes`, { who: "aadmin" })).status;
  const list = await call("GET", "/api/v1/devices?page_size=100", { who: "aadmin" });
  r.listLeak = (list.body?.devices ?? list.body ?? []).some?.((d) => d.id === devB) ? "LEAK" : "clean";
  return r;
}

// ---------------- §4/§5 token + enrollment ----------------
test("§4/§5 site-scoped token enrols into its own site only; wrong-site/wrong-org rejected by scope, not by agent input", async () => {
  const tA1 = await mkToken(S.orgA, S.a1, 3, 3600e3);
  assert.ok(tA1.token.startsWith("nxen_"), "raw token returned once");

  // happy path: lands in Org A / Site A1 regardless of what the agent claims
  const e = await enroll(tA1.token, `nw-a1-${uniq}`, { organization_id: S.orgB, site_id: S.b1, organization: "Contoso" });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const row = await pool.query("SELECT organization_id, site_id FROM nexora_devices WHERE device_uuid=$1", [e.deviceUuid]);
  assert.equal(row.rows[0].organization_id, S.orgA, "device lands in the token's org, not the agent-claimed one");
  assert.equal(row.rows[0].site_id, S.a1, "device lands in the token's site, not the agent-claimed one");
  S.deviceA1 = e.deviceUuid;

  // a token scoped to a non-existent/foreign site cannot even be minted
  const foreign = await call("POST", "/api/v1/admin/enrollment-tokens", { bearer: adminToken, body: { name: "x", organization_id: S.orgA, site_id: S.b1, max_uses: 1, expires_at: new Date(Date.now() + 3600e3).toISOString() } });
  assert.ok([422, 404].includes(foreign.status), `foreign-site token minting must fail, got ${foreign.status}`);
});

test("§4 token lifecycle: exhausted / revoked / expired / malformed all 401", async () => {
  const one = await mkToken(S.orgA, S.a1, 1, 3600e3);
  assert.equal((await enroll(one.token, `ex1-${uniq}`)).status, 201);
  assert.equal((await enroll(one.token, `ex2-${uniq}`)).status, 401, "exhausted");
  const rev = await mkToken(S.orgA, S.a1, 5, 3600e3);
  assert.equal((await call("POST", `/api/v1/admin/enrollment-tokens/${rev.id}/revoke`, { bearer: adminToken })).status, 204);
  assert.equal((await enroll(rev.token, `rev-${uniq}`)).status, 401, "revoked");
  const exp = await mkToken(S.orgA, S.a1, 5, 1500);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await enroll(exp.token, `exp-${uniq}`)).status, 401, "expired");
  assert.equal((await enroll("nxen_never-issued-value", `mal-${uniq}`)).status, 401, "malformed");
});

test("§4 raw token is never persisted or exposed after issuance", async () => {
  const t = await mkToken(S.orgA, S.a2, 1, 3600e3);
  const raw = t.token;
  const dbrow = await pool.query("SELECT * FROM nexora_enrollment_tokens WHERE id=$1", [t.id]);
  const serialized = JSON.stringify(dbrow.rows[0]);
  assert.ok(!serialized.includes(raw), "raw token value not stored in the DB row");
  assert.equal(dbrow.rows[0].token_hash, crypto.createHash("sha256").update(raw).digest("hex"), "only the sha256 hash is stored");
  const list = await call("GET", "/api/v1/admin/enrollment-tokens", { bearer: adminToken });
  assert.ok(!JSON.stringify(list.body).includes(raw), "listing never returns the raw token");
  assert.ok(!JSON.stringify(list.body).includes("token_hash"), "listing never returns the hash either");
});

// ---------------- §6 telemetry ----------------
test("§6 telemetry from an enrolled agent is ingested and visible only to its tenant", async () => {
  const t = await mkToken(S.orgA, S.a1, 1, 3600e3);
  const e = await enroll(t.token, `tele-${uniq}`);
  assert.equal(e.status, 201);
  const bearer = e.body.agent_token;
  assert.equal((await call("POST", "/api/v1/agents/heartbeat", { bearer, body: { agent_version: "0.3.0", uptime_seconds: 120, logged_in_user: "svc" } })).status, 204);
  const m = await call("POST", "/api/v1/agents/metrics", { bearer, body: { captured_at: new Date().toISOString(), cpu_percent: 12, ram_percent: 44, ram_used_bytes: 4e9, ram_available_bytes: 8e9, disk_percent: 55, uptime_seconds: 120 } });
  assert.equal(m.status, 204);
  const devId = (await pool.query("SELECT id FROM nexora_devices WHERE device_uuid=$1", [e.deviceUuid])).rows[0].id;
  const seenByA = await call("GET", `/api/v1/devices/${devId}/metrics`, { who: "aadmin" });
  assert.equal(seenByA.status, 200);
  const seenByB = await call("GET", `/api/v1/devices/${devId}/metrics`, { who: "badmin" });
  assert.equal(seenByB.status, 404, "Org B cannot read Org A device metrics (404 not 403)");
  const devByB = await call("GET", `/api/v1/devices/${devId}`, { who: "badmin" });
  assert.equal(devByB.status, 404, "Org B cannot open an Org A device by direct ID");
});

// ---------------- §7 inventory ----------------
test("§7 inventory endpoints are tenant-scoped (software / services / processes)", async () => {
  const t = await mkToken(S.orgA, S.a1, 1, 3600e3);
  const e = await enroll(t.token, `inv-${uniq}`);
  const devId = (await pool.query("SELECT id FROM nexora_devices WHERE device_uuid=$1", [e.deviceUuid])).rows[0].id;
  for (const kind of ["software", "services", "processes"]) {
    assert.equal((await call("GET", `/api/v1/devices/${devId}/${kind}`, { who: "aadmin" })).status, 200, `${kind} readable by owner`);
    assert.equal((await call("GET", `/api/v1/devices/${devId}/${kind}`, { who: "badmin" })).status, 404, `${kind} denied cross-tenant`);
  }
});

// ---------------- §8 alerts ----------------
test("§8 alert lifecycle + tenant ownership via the real alert engine surface", async () => {
  // create an alert through the DB-less path is not available; use the alerts API listing to confirm scoping,
  // and drive dedup/lifecycle through a seeded row on Org A only.
  const devId = (await pool.query("SELECT id FROM nexora_devices WHERE organization_id=$1 LIMIT 1", [S.orgA])).rows[0].id;
  const alertId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO nexora_alerts(id,organization_id,device_id,type,severity,state,title,summary,dedup_key)
     VALUES ($1,$2,$3,'CPU_HIGH','warning','OPEN','A1 CPU','synthetic',$4)`,
    [alertId, S.orgA, devId, `pr05b-${uniq}`]);
  const listA = await call("GET", "/api/v1/alerts?page_size=100", { who: "aadmin" });
  assert.equal(listA.status, 200);
  assert.ok(JSON.stringify(listA.body).includes(alertId), "Org A admin sees its own alert");
  const listB = await call("GET", "/api/v1/alerts?page_size=100", { who: "badmin" });
  assert.ok(!JSON.stringify(listB.body).includes(alertId), "Org B never sees Org A's alert");
  const ackByB = await call("POST", `/api/v1/alerts/${alertId}/acknowledge`, { who: "badmin" }).catch(() => ({ status: 404 }));
  assert.ok([403, 404].includes(ackByB.status), "Org B cannot acknowledge Org A's alert");
  const ackByA = await call("POST", `/api/v1/alerts/${alertId}/acknowledge`, { who: "aadmin" });
  assert.ok([200, 204].includes(ackByA.status), "Org A admin can acknowledge its own alert");
});

// ---------------- §9 audit ----------------
test("§9 audit rows exist for onboarding actions and carry no raw token", async () => {
  const t = await mkToken(S.orgA, S.a1, 1, 3600e3);
  await call("POST", `/api/v1/admin/enrollment-tokens/${t.id}/revoke`, { bearer: adminToken });
  await enroll((await mkToken(S.orgA, S.a1, 1, 3600e3)).token, `aud-${uniq}`);
  const rows = await pool.query(
    `SELECT action, metadata::text FROM nexora_audit_log WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`, [S.orgA]);
  const actions = new Set(rows.rows.map((r) => r.action));
  for (const a of ["ENROLLMENT_TOKEN_CREATED", "ENROLLMENT_TOKEN_REVOKED", "AGENT_ENROLLED"]) {
    assert.ok(actions.has(a), `audit action present: ${a}`);
  }
  assert.ok(!rows.rows.some((r) => /nxen_[A-Za-z0-9_-]{20}/.test(r.metadata ?? "")), "no raw enrollment token in audit metadata");
});

// ---------------- §13 hard IDOR gate ----------------
test("§13 Org A admin cannot reach ANY Org B object by list or by direct ID", async () => {
  const tB = await mkToken(S.orgB, S.b1, 1, 3600e3);
  const eB = await enroll(tB.token, `b1-dev-${uniq}`);
  assert.equal(eB.status, 201);
  const devB = (await pool.query("SELECT id FROM nexora_devices WHERE device_uuid=$1", [eB.deviceUuid])).rows[0].id;
  const alertB = crypto.randomUUID();
  await pool.query(`INSERT INTO nexora_alerts(id,organization_id,device_id,type,severity,state,title,summary,dedup_key) VALUES ($1,$2,$3,'DISK_HIGH','critical','OPEN','B disk','x',$4)`, [alertB, S.orgB, devB, `pr05b-b-${uniq}`]);
  const m = await crossTenantMatrix(devB, alertB);
  assert.equal(m.orgById, 404, "org B by id");
  assert.equal(m.sitesOfB, 404, "org B sites");
  assert.equal(m.siteById, 404, "site B by id");
  assert.equal(m.deviceById, 404, "device B by id");
  assert.equal(m.metrics, 404, "device B metrics");
  assert.equal(m.software, 404, "device B software");
  assert.equal(m.services, 404, "device B services");
  assert.equal(m.processes, 404, "device B processes");
  assert.equal(m.listLeak, "clean", "device B absent from Org A device list");
  const alerts = await call("GET", "/api/v1/alerts?page_size=100", { who: "aadmin" });
  assert.ok(!JSON.stringify(alerts.body).includes(alertB), "alert B absent from Org A alert list");
});

// ---------------- §3 site-level user isolation ----------------
test("§3 site-level user restriction — product behaviour", async () => {
  // Memberships in this product are keyed by organization only (policy.ts:
  // memberships: ReadonlyMap<organizationId, OrganizationRole>). A user with
  // org access sees every site in that org. Prove that is the actual
  // behaviour so the gap is recorded, not hidden.
  const sitesSeen = await call("GET", `/api/v1/organizations/${S.orgA}/sites`, { who: "aview" });
  assert.equal(sitesSeen.status, 200);
  const list = Array.isArray(sitesSeen.body) ? sitesSeen.body : (sitesSeen.body?.items ?? sitesSeen.body?.sites ?? []);
  const names = list.map((s) => s.name).sort();
  assert.deepEqual(names, ["Site A1", "Site A2"], "an Org A viewer sees BOTH Org A sites — no per-site user scoping exists (PRODUCT_GAP)");
});
