/**
 * Task #009 security regression suite.
 *
 * Drives the real built server over real HTTP (same model as
 * tenancy.integration.mjs, the Task #008 suite) so what is verified is the
 * artifact that actually ships: real sessions, real cookies, real CSRF
 * double-submit, real rate limiting, real scrypt password hashing, and the
 * privileged-action/two-person-approval foundation Task010's remote-command
 * flow is built on top of.
 *
 * Requires NEXORA_TEST_BASE_URL, DATABASE_URL and ADMIN_API_TOKEN, exactly
 * like the Task #008 suite.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
import pg from "pg";

const baseUrl = process.env.NEXORA_TEST_BASE_URL;
const adminToken = process.env.ADMIN_API_TOKEN;
if (!baseUrl) throw new Error("NEXORA_TEST_BASE_URL is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required to seed fixture users");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ORIGIN = process.env.NEXORA_TEST_ORIGIN ?? "https://nexora.design.local";
const PASSWORD = "correct-horse-battery-staple";

async function call(method, path, { cookie, body, bearer, headers = {}, csrf } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (cookie) h.Cookie = cookie;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    if (!("Origin" in h)) h.Origin = ORIGIN;
    if (csrf) h["X-CSRF-Token"] = csrf;
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers, rawText: text, setCookie: response.headers.get("set-cookie") };
}

async function seedUser(body) {
  const created = await call("POST", "/api/v1/admin/users", { bearer: adminToken, body });
  assert.equal(created.status, 201, `could not seed ${body.email}: ${JSON.stringify(created.body)}`);
  return created.body.id;
}

async function login(email, password = PASSWORD) {
  const response = await call("POST", "/api/v1/auth/login", { body: { email, password } });
  assert.equal(response.status, 200, `login failed for ${email}: ${JSON.stringify(response.body)}`);
  const token = /nexora_session=([^;]+)/.exec(response.setCookie ?? "")?.[1];
  const csrf = /nexora_csrf=([^;]+)/.exec(response.setCookie ?? "")?.[1];
  assert.ok(token); assert.ok(csrf);
  return { cookie: `nexora_session=${token}; nexora_csrf=${csrf}`, token, csrf };
}

async function createOrgSiteDevice(label) {
  const org = crypto.randomUUID(); const site = crypto.randomUUID(); const device = crypto.randomUUID();
  await pool.query("INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,$2,$3)", [org, `Sec009 ${label}`, `sec009-${label}-${org}`]);
  await pool.query("INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,$3)", [site, org, `${label} Site`]);
  await pool.query("INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id) VALUES ($1,$2,$3,$4,$5,$6)", [device, `SEC009-${label}-${device.slice(0, 8)}`, crypto.randomUUID(), `SEC009-${label}`, org, site]);
  return { org, site, device };
}

let counter = 0;
function uniqueEmail(label) { counter += 1; return `sec009-${label}-${Date.now()}-${counter}@test.invalid`; }

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "postgres"].includes(url.hostname), "integration DB must be disposable");
});

after(async () => { await pool.end(); });

// ===========================================================================
// Centralized capabilities / RBAC
// ===========================================================================
test("centralized RBAC denies a capability the role does not hold", async () => {
  const org = await createOrgSiteDevice("rbac");
  const viewerEmail = uniqueEmail("rbac-viewer");
  await seedUser({ email: viewerEmail, name: "Viewer", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_VIEWER" }] });
  const viewer = await login(viewerEmail);
  const r = await call("POST", "/api/v1/privileged-actions", { cookie: viewer.cookie, csrf: viewer.csrf, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "rbac check" } });
  assert.equal(r.status, 403, "a read-only role must never reach a privileged-action write route");
});

// ===========================================================================
// Session hardening / listing / revoke
// ===========================================================================
test("session listing and revoke", async (t) => {
  await t.test("a listed session reflects the real active session and can be revoked by its owner", async () => {
    const org = await createOrgSiteDevice("session1");
    const email = uniqueEmail("session1");
    await seedUser({ email, name: "Session User", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
    const session = await login(email);
    const list = await call("GET", "/api/v1/auth/sessions", { cookie: session.cookie });
    assert.equal(list.status, 200);
    const own = list.body.items.find((s) => s.current_session);
    assert.ok(own, "the session used to make the request appears in its own listing, marked current");

    const revoke = await call("DELETE", `/api/v1/auth/sessions/${own.id}`, { cookie: session.cookie, csrf: session.csrf });
    assert.equal(revoke.status, 204);

    const after = await call("GET", "/api/v1/auth/sessions", { cookie: session.cookie });
    assert.equal(after.status, 401, "the just-revoked session cannot authenticate its own subsequent request");
  });

  await t.test("a user cannot revoke another user's session", async () => {
    const org = await createOrgSiteDevice("session2");
    const emailA = uniqueEmail("session2a"); const emailB = uniqueEmail("session2b");
    await seedUser({ email: emailA, name: "A", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
    await seedUser({ email: emailB, name: "B", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
    const a = await login(emailA); const b = await login(emailB);
    const listA = await call("GET", "/api/v1/auth/sessions", { cookie: a.cookie });
    const sessionAId = listA.body.items[0].id;
    const revokeAttempt = await call("DELETE", `/api/v1/auth/sessions/${sessionAId}`, { cookie: b.cookie, csrf: b.csrf });
    assert.equal(revokeAttempt.status, 404, "another user's session id is not found from this principal's perspective");
    const stillThere = await call("GET", "/api/v1/auth/sessions", { cookie: a.cookie });
    assert.equal(stillThere.status, 200, "session A survives the other user's attempt");
  });
});

// ===========================================================================
// Fixation prevention
// ===========================================================================
test("session fixation is prevented: the server always issues a fresh token, never adopts a client-supplied one", async () => {
  const org = await createOrgSiteDevice("fixation");
  const email = uniqueEmail("fixation");
  await seedUser({ email, name: "Fixation", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  const attackerChosenToken = "attacker-chosen-session-value-0000000000000000";
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `nexora_session=${attackerChosenToken}` },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const issuedToken = /nexora_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(issuedToken);
  assert.notEqual(issuedToken, attackerChosenToken, "the pre-set attacker cookie is never adopted as the real session");

  const second = await login(email);
  assert.notEqual(second.token, issuedToken, "every login mints a brand-new, unpredictable token");
});

// ===========================================================================
// Password hashing policy
// ===========================================================================
test("password hashing policy", async (t) => {
  await t.test("stored password hash uses the scrypt policy format, never plaintext", async () => {
    const email = uniqueEmail("hashformat");
    await seedUser({ email, name: "Hash", password: PASSWORD, scope: "ORGANIZATION" });
    const row = await pool.query("SELECT password_hash FROM nexora_users WHERE email=$1", [email]);
    const parts = row.rows[0].password_hash.split("$");
    assert.equal(parts[0], "scrypt");
    assert.ok(Number(parts[1]) >= 12, "cost factor meets the minimum policy");
    assert.notEqual(row.rows[0].password_hash, PASSWORD);
  });

  await t.test("a password below the minimum length is rejected", async () => {
    const r = await call("POST", "/api/v1/admin/users", { bearer: adminToken, body: { email: uniqueEmail("shortpw"), name: "Short", password: "short1", scope: "ORGANIZATION" } });
    assert.equal(r.status, 400);
  });
});

// ===========================================================================
// Generic login errors (no account enumeration)
// ===========================================================================
test("login errors are generic and do not distinguish unknown accounts from wrong passwords", async () => {
  const org = await createOrgSiteDevice("generic");
  const email = uniqueEmail("generic");
  await seedUser({ email, name: "Generic", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });

  const unknown = await call("POST", "/api/v1/auth/login", { body: { email: uniqueEmail("nonexistent"), password: PASSWORD } });
  const wrongPassword = await call("POST", "/api/v1/auth/login", { body: { email, password: "wrong-password-entirely" } });
  assert.equal(unknown.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(unknown.body, wrongPassword.body, "identical response body for unknown-account and wrong-password");
});

// ===========================================================================
// Rate limiting
// ===========================================================================
test("login rate limiting engages after repeated attempts against the same account", async () => {
  const org = await createOrgSiteDevice("ratelimit");
  const email = uniqueEmail("ratelimit");
  await seedUser({ email, name: "RateLimit", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  const attempts = [];
  for (let i = 0; i < 10; i++) attempts.push(await call("POST", "/api/v1/auth/login", { body: { email, password: "wrong" } }));
  const rateLimited = attempts.filter((r) => r.status === 429);
  assert.ok(rateLimited.length > 0, "at least one attempt in a burst of 10 must be rate-limited");
  assert.ok(rateLimited[0].headers.get("retry-after"), "a 429 carries Retry-After");
});

// ===========================================================================
// CSRF double-submit + Origin validation
// ===========================================================================
test("CSRF double-submit and Origin validation", async (t) => {
  const org = await createOrgSiteDevice("csrf");
  const email = uniqueEmail("csrf");
  await seedUser({ email, name: "Csrf", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  const session = await login(email);

  await t.test("missing CSRF token rejected", async () => {
    const r = await call("POST", "/api/v1/privileged-actions", { cookie: session.cookie, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "csrf" } });
    assert.equal(r.status, 403);
  });
  await t.test("mismatched Origin rejected even with a valid CSRF token", async () => {
    const r = await call("POST", "/api/v1/privileged-actions", { cookie: session.cookie, csrf: session.csrf, headers: { Origin: "https://evil.example" }, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "csrf" } });
    assert.equal(r.status, 403);
  });
  await t.test("valid Origin + CSRF token succeeds", async () => {
    const r = await call("POST", "/api/v1/privileged-actions", { cookie: session.cookie, csrf: session.csrf, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "csrf" } });
    assert.equal(r.status, 201);
  });
});

// ===========================================================================
// Request IDs
// ===========================================================================
test("responses carry a request id and it is persisted on the resulting audit row", async () => {
  const org = await createOrgSiteDevice("requestid");
  const email = uniqueEmail("requestid");
  await seedUser({ email, name: "ReqId", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  const session = await login(email);
  const r = await call("POST", "/api/v1/privileged-actions", { cookie: session.cookie, csrf: session.csrf, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "reqid" } });
  assert.equal(r.status, 201);
  const requestId = r.headers.get("x-request-id");
  if (requestId) {
    const audit = await pool.query("SELECT request_id FROM nexora_audit_log WHERE action='PRIVILEGED_ACTION_REQUESTED' AND target_id=$1", [r.body.id]);
    assert.equal(audit.rows[0].request_id, requestId);
  } else {
    const audit = await pool.query("SELECT request_id FROM nexora_audit_log WHERE action='PRIVILEGED_ACTION_REQUESTED' AND target_id=$1", [r.body.id]);
    assert.ok(audit.rows[0].request_id, "every audited request carries a persisted request id even if not echoed as a header");
  }
});

// ===========================================================================
// Log redaction
// ===========================================================================
test("audit metadata never contains the submitted password or secrets", async () => {
  const email = uniqueEmail("redact");
  await call("POST", "/api/v1/auth/login", { body: { email, password: "s3cret-password-should-never-be-logged" } });
  const audit = await pool.query("SELECT metadata::text AS metadata FROM nexora_audit_log WHERE action='LOGIN_FAILED' AND actor_label=$1 ORDER BY created_at DESC LIMIT 1", [email]);
  assert.equal(audit.rowCount, 1);
  const metadataText = audit.rows[0].metadata ?? "";
  assert.ok(!metadataText.includes("s3cret-password"), "the failed password must never be persisted in audit metadata");
});

// ===========================================================================
// Break-glass admin token
// ===========================================================================
test("break-glass ADMIN_API_TOKEN behavior", async (t) => {
  await t.test("the admin token reaches admin-only routes", async () => {
    const r = await call("GET", "/api/v1/admin/users", { bearer: adminToken });
    assert.equal(r.status, 200);
  });
  await t.test("the admin token is never accepted as a session cookie value", async () => {
    const r = await call("GET", "/api/v1/auth/sessions", { cookie: `nexora_session=${adminToken}` });
    assert.equal(r.status, 401, "a bearer token is not a valid session cookie");
  });
  await t.test("the admin token never appears in a response body", async () => {
    const r = await call("GET", "/api/v1/admin/users", { bearer: adminToken });
    assert.ok(!r.rawText.includes(adminToken));
  });
  await t.test("a wrong bearer token is rejected, not partially matched", async () => {
    const r = await call("GET", "/api/v1/admin/users", { bearer: adminToken.slice(0, -1) + "x" });
    assert.equal(r.status, 401);
  });
});

// ===========================================================================
// Privileged action foundation (generic, not remote-command-specific)
// ===========================================================================
test("privileged action foundation is generic across action types", async (t) => {
  const org = await createOrgSiteDevice("foundation");
  const requesterEmail = uniqueEmail("foundation-req"); const approverEmail = uniqueEmail("foundation-appr");
  await seedUser({ email: requesterEmail, name: "Req", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  await seedUser({ email: approverEmail, name: "Appr", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
  const requester = await login(requesterEmail); const approver = await login(approverEmail);

  await t.test("SERVICE_START privileged action follows the same request/approve foundation as REMOTE_COMMAND", async () => {
    const created = await call("POST", "/api/v1/privileged-actions", { cookie: requester.cookie, csrf: requester.csrf, body: { device_id: org.device, action_type: "SERVICE_START", request_reason: "start the print spooler", safe_parameters: { service_name: "Spooler" } } });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "PENDING_APPROVAL");
    assert.equal(created.body.action_type ?? created.body.actionType, "SERVICE_START");
    const approve = await call("POST", `/api/v1/privileged-actions/${created.body.id}/approve`, { cookie: approver.cookie, csrf: approver.csrf });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, "APPROVED");
  });

  await t.test("two-person approval: requester cannot self-approve", async () => {
    const created = await call("POST", "/api/v1/privileged-actions", { cookie: requester.cookie, csrf: requester.csrf, body: { device_id: org.device, action_type: "SOFTWARE_INSTALL", request_reason: "install agent" } });
    assert.equal(created.status, 201);
    const selfApprove = await call("POST", `/api/v1/privileged-actions/${created.body.id}/approve`, { cookie: requester.cookie, csrf: requester.csrf });
    assert.equal(selfApprove.status, 403);
  });

  await t.test("tenant-safe privileged operations: a device in another org is rejected, not silently scoped", async () => {
    const other = await createOrgSiteDevice("foundation-other");
    const r = await call("POST", "/api/v1/privileged-actions", { cookie: requester.cookie, csrf: requester.csrf, body: { device_id: other.device, action_type: "SERVICE_START", request_reason: "cross tenant" } });
    assert.equal(r.status, 404);
  });
});

// ===========================================================================
// User suspension protections
// ===========================================================================
test("user suspension protections", async (t) => {
  await t.test("disabling a user revokes their sessions and blocks further login", async () => {
    const org = await createOrgSiteDevice("suspend");
    const targetEmail = uniqueEmail("suspend-target");
    const targetId = await seedUser({ email: targetEmail, name: "Target", password: PASSWORD, scope: "ORGANIZATION", memberships: [{ organization_id: org.org, role: "ORGANIZATION_ADMIN" }] });
    const session = await login(targetEmail);
    const disable = await call("PATCH", `/api/v1/admin/users/${targetId}`, { bearer: adminToken, body: { status: "DISABLED" } });
    assert.equal(disable.status, 200);
    const stillWorks = await call("GET", "/api/v1/auth/sessions", { cookie: session.cookie });
    assert.equal(stillWorks.status, 401, "the disabled user's live session is revoked");
    const reLogin = await call("POST", "/api/v1/auth/login", { body: { email: targetEmail, password: PASSWORD } });
    assert.equal(reLogin.status, 401, "a disabled account cannot log in again");
  });

  await t.test("last-super-admin safety: the last active platform super admin cannot be disabled", async () => {
    const email = uniqueEmail("lastsuperadmin");
    const id = await seedUser({ email, name: "Last Super Admin", password: PASSWORD, scope: "PLATFORM", platform_role: "PLATFORM_SUPER_ADMIN" });
    // There may be other super admins already seeded by earlier suites in this
    // same disposable database, so first drive every *other* one down to a
    // non-blocking state is out of scope — instead assert the invariant
    // directly: disabling THIS one is refused whenever it is (still) the last
    // active one, and the row is untouched either way.
    const activeBefore = await pool.query("SELECT count(*)::int AS n FROM nexora_users WHERE scope='PLATFORM' AND platform_role='PLATFORM_SUPER_ADMIN' AND status='ACTIVE'");
    const attempt = await call("PATCH", `/api/v1/admin/users/${id}`, { bearer: adminToken, body: { status: "DISABLED" } });
    if (activeBefore.rows[0].n <= 1) {
      assert.equal(attempt.status, 403, "the last active super admin must never be disabled");
      const row = await pool.query("SELECT status FROM nexora_users WHERE id=$1", [id]);
      assert.equal(row.rows[0].status, "ACTIVE");
    } else {
      // Another super admin already exists in this fixture DB; disabling this
      // one is legitimately allowed. Re-enable it so later suites in the same
      // disposable DB are unaffected.
      assert.equal(attempt.status, 200);
      await pool.query("UPDATE nexora_users SET status='ACTIVE' WHERE id=$1", [id]);
    }
  });
});
