// Task #010V — Execution Lifecycle Safety Acceptance Suite
//
// Extends the Task #010 signed-protocol infrastructure (real Express app via
// createApp(), real disposable PostgreSQL 16, real Drizzle migrations, real
// session/CSRF/RBAC, real Agent bearer + ECDSA signing) with the terminal
// lifecycle: cancellation (READY and RUNNING), cancellation/result races,
// the terminal result matrix, result idempotency and conflicts, output
// persistence, lease safety, stale reconciliation (UNKNOWN/EXPIRED/TIMED_OUT),
// restart ambiguity, maintenance concurrency, tenant isolation and audit.
// No verifier/route/reconciler is reimplemented — this drives the production
// code in src/routes/remote-commands.ts, src/routes/security.ts and
// src/remote-commands/maintenance.ts directly.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import pg from "pg";
import { createApp } from "./app.ts";
import { hashPassword } from "./auth/password.ts";
import { canonicalAgentRequest } from "./security/agent-signing.ts";
import { resetLoginRateForTests } from "./security/rate-limit.ts";
import { reconcileRemoteCommands } from "./remote-commands/maintenance.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENTINELS = {
  adminToken: "TEST_ADMIN_TOKEN_SENTINEL",
  enrollmentSecret: "TEST_ENROLLMENT_SECRET_SENTINEL",
  agentBearer: "TEST_AGENT_BEARER_SENTINEL",
  executionCapability: "TEST_EXECUTION_CAPABILITY_SENTINEL",
  privateKey: "TEST_PRIVATE_KEY_SENTINEL",
};

let server;
let baseUrl;

function assertSyntheticDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "postgres"].includes(url.hostname), "integration DB must be disposable");
  assert.match(url.pathname, /test|integration|task010/);
}

async function call(method, path, { body, headers = {}, cookie } = {}) {
  const h = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  if (cookie) h.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers, rawText: text };
}

async function createOrgSite(label) {
  const org = crypto.randomUUID();
  const site = crypto.randomUUID();
  await pool.query("INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,$2,$3)", [org, `Task010V ${label}`, `task010v-${label}-${org}`]);
  await pool.query("INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,$3)", [site, org, `${label} Site`]);
  return { org, site };
}

async function createUser(orgId, role, label) {
  const id = crypto.randomUUID();
  // Every production write path lowercases email at the boundary (see
  // routes/users.ts, routes/auth.ts login) and login compares case-sensitively
  // against whatever was stored, so this direct-SQL fixture insert must match
  // that same normalization or a mixed-case test label breaks its own login.
  const email = `task010v-${label}-${id}@test.invalid`.toLowerCase();
  const password = `task010v-${label}-password`;
  const passwordHash = await hashPassword(password);
  await pool.query("INSERT INTO nexora_users(id,email,name,password_hash,scope,platform_role) VALUES ($1,$2,$3,$4,'ORGANIZATION',NULL)", [id, email, `Task010V ${label}`, passwordHash]);
  await pool.query("INSERT INTO nexora_organization_memberships(user_id,organization_id,role) VALUES ($1,$2,$3)", [id, orgId, role]);
  return { id, email, password };
}

async function login(user) {
  // See the Task010 security suite: this suite performs far more logins than
  // the production per-IP/per-account rate limit allows within its window;
  // that limiter is exercised on its own merits elsewhere, so it is reset
  // before every login using the reset hook the limiter exports for tests.
  resetLoginRateForTests();
  const response = await call("POST", "/v1/auth/login", { body: { email: user.email, password: user.password } });
  assert.equal(response.status, 200, `login must succeed for ${user.email}`);
  const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie().join(";") : (response.headers.get("set-cookie") ?? "");
  const cookie = `${/nexora_session=([^;]+)/.exec(setCookie)?.[0] ?? ""}; nexora_csrf=${response.body.csrf_token}`;
  return { cookie, csrf: response.body.csrf_token };
}

async function createAgentIdentity(orgId, siteId, label, { remoteCommandsEnabled = true, capabilities = ["remote_command_v1"] } = {}) {
  const device = crypto.randomUUID();
  const agentId = `TASK010V-${label}-${device.slice(0, 8)}`;
  const token = `${SENTINELS.agentBearer}-${crypto.randomUUID()}`;
  const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id,remote_commands_enabled,capabilities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [device, agentId, crypto.randomUUID(), `TASK010V-${label}`, orgId, siteId, remoteCommandsEnabled, JSON.stringify(capabilities)],
  );
  await pool.query("INSERT INTO nexora_agent_credentials(device_id,token_hash) VALUES ($1,$2)", [device, crypto.createHash("sha256").update(token).digest("hex")]);
  await pool.query(
    "INSERT INTO nexora_agent_signing_keys(id,device_id,algorithm,public_key,key_fingerprint,protocol_version) VALUES ($1,$2,'ECDSA_P256_SHA256',$3,$4,'remote_command_v1')",
    [keyId, device, publicKey, crypto.createHash("sha256").update(publicKey).digest("hex")],
  );
  return { device, agentId, token, keyId, keyPair, org: orgId, site: siteId };
}

function signedHeaders(agent, method, path, body = "", overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? crypto.randomBytes(16).toString("hex");
  const keyId = overrides.keyId ?? agent.keyId;
  const agentIdForCanonical = overrides.agentIdForCanonical ?? agent.agentId;
  const canonical = canonicalAgentRequest(overrides.canonicalMethod ?? method, overrides.canonicalPath ?? path, Buffer.from(overrides.canonicalBody ?? body), timestamp, nonce, agentIdForCanonical, keyId);
  const signingKey = overrides.privateKey ?? agent.keyPair.privateKey;
  const signature = overrides.signature ?? crypto.sign("sha256", Buffer.from(canonical), { key: signingKey, dsaEncoding: "der" }).toString("base64");
  const headers = { authorization: `Bearer ${overrides.token ?? agent.token}`, "x-nexora-signature-version": overrides.version ?? "nexora-agent-sign-v1", "x-nexora-key-id": keyId, "x-nexora-timestamp": timestamp, "x-nexora-nonce": nonce, "x-nexora-signature": signature };
  if (overrides.omit) for (const h of overrides.omit) delete headers[h];
  return headers;
}

async function signedCall(agent, method, path, bodyObj = {}, overrides = {}) {
  const bodyText = JSON.stringify(bodyObj);
  return call(method, path, { body: bodyObj, headers: signedHeaders(agent, method, path, bodyText, overrides) });
}

// Full path: authorized user request -> two-person approval -> READY, using
// the real privileged-action approval routes end to end.
async function requestApprovedReadyJob({ requester, approver, device }) {
  const created = await call("POST", "/v1/remote-commands", {
    cookie: requester.cookie,
    headers: { origin: "http://127.0.0.1", "x-csrf-token": requester.csrf },
    body: { device_id: device, shell: "CMD", command: "echo task010v", reason: "task010v acceptance" },
  });
  assert.equal(created.status, 201, `remote command request must succeed: ${JSON.stringify(created.body)}`);
  const approved = await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, {
    cookie: approver.cookie,
    headers: { origin: "http://127.0.0.1", "x-csrf-token": approver.csrf },
  });
  assert.equal(approved.status, 200, `approval must succeed: ${JSON.stringify(approved.body)}`);
  return created.body;
}

async function claimJob(agent) {
  const r = await signedCall(agent, "POST", "/v1/agent/remote-commands/claim", {});
  return r;
}

async function startJob(agent, jobId, execution) {
  const path = `/v1/agent/remote-commands/${jobId}/start`;
  return signedCall(agent, "POST", path, { execution_id: execution.execution_id, execution_capability: execution.execution_capability });
}

async function heartbeatJob(agent, jobId, execution) {
  const path = `/v1/agent/remote-commands/${jobId}/heartbeat`;
  return signedCall(agent, "POST", path, { execution_id: execution.execution_id, execution_capability: execution.execution_capability });
}

async function statusJob(agent, jobId) {
  const path = `/v1/agent/remote-commands/${jobId}/status`;
  return signedCall(agent, "POST", path, {});
}

async function resultJob(agent, jobId, execution, result = {}) {
  const path = `/v1/agent/remote-commands/${jobId}/result`;
  return signedCall(agent, "POST", path, { execution_id: execution.execution_id, execution_capability: execution.execution_capability, ...result });
}

// Full setup: fresh org/site/agent/requester/approver, then READY job.
async function scenario(label) {
  const { org, site } = await createOrgSite(label);
  const agent = await createAgentIdentity(org, site, label.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "AGENT");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", `${label}-req`);
  const approver = await createUser(org, "ORGANIZATION_ADMIN", `${label}-appr`);
  return { org, site, agent, requester, approver };
}

async function readyJob(s) {
  const requesterSession = await login(s.requester);
  const approverSession = await login(s.approver);
  const job = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, device: s.agent.device });
  return { job, requesterSession, approverSession };
}

async function runningJob(s) {
  const { job, requesterSession, approverSession } = await readyJob(s);
  const claim = await claimJob(s.agent);
  assert.equal(claim.status, 200, `claim must succeed: ${JSON.stringify(claim.body)}`);
  const start = await startJob(s.agent, job.id, claim.body);
  assert.equal(start.status, 200, `start must succeed: ${JSON.stringify(start.body)}`);
  return { job, execution: claim.body, requesterSession, approverSession };
}

async function jobRow(id) {
  const { rows } = await pool.query("SELECT * FROM nexora_remote_command_jobs WHERE id=$1", [id]);
  return rows[0];
}

before(async () => {
  assertSyntheticDatabase();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ===========================================================================
// READY CANCELLATION (cases 1-10)
// ===========================================================================
test("READY cancellation", async (t) => {
  await t.test("1. READY job can be cancelled by authorized user", async () => {
    const s = await scenario("readycancel1");
    const { job, approverSession } = await readyJob(s);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "CANCELLED");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCELLED");
  });

  await t.test("2. auth required", async () => {
    const s = await scenario("readycancel2");
    const { job } = await readyJob(s);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { headers: { origin: "http://127.0.0.1" } });
    assert.equal(r.status, 401);
    const row = await jobRow(job.id);
    assert.equal(row.status, "READY");
  });

  await t.test("3. CSRF required", async () => {
    const s = await scenario("readycancel3");
    const { job, approverSession } = await readyJob(s);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1" } });
    assert.equal(r.status, 403);
    const row = await jobRow(job.id);
    assert.equal(row.status, "READY");
  });

  await t.test("4. capability required (viewer role lacks remote_commands.cancel)", async () => {
    const s = await scenario("readycancel4");
    const { job } = await readyJob(s);
    const viewer = await createUser(s.org, "ORGANIZATION_VIEWER", "readycancel4-viewer");
    const viewerSession = await login(viewer);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: viewerSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": viewerSession.csrf } });
    assert.equal(r.status, 403);
    const row = await jobRow(job.id);
    assert.equal(row.status, "READY");
  });

  await t.test("5. cross-tenant cancellation safely rejected", async () => {
    const s = await scenario("readycancel5a");
    const other = await scenario("readycancel5b");
    const { job } = await readyJob(s);
    const otherSession = await login(other.approver);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: otherSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": otherSession.csrf } });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "READY");
  });

  await t.test("6-8. cancelled READY job cannot be claimed; no execution ID/authorization created", async () => {
    const s = await scenario("readycancel678");
    const { job, approverSession } = await readyJob(s);
    const cancel = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(cancel.status, 200);
    const claim = await claimJob(s.agent);
    assert.equal(claim.status, 204, "cancelled job is not eligible for claim");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.execution_id, null, "no execution ID was ever created");
    assert.equal(row.execution_capability_hash, null, "no execution authorization was ever created");
  });

  await t.test("9. repeated cancellation is idempotent (safe, deterministic, no corruption)", async () => {
    const s = await scenario("readycancel9");
    const { job, approverSession } = await readyJob(s);
    const first = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(first.status, 200);
    const second = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(second.status, 409, "a repeat cancel on an already-terminal job is safely refused, not silently reprocessed");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCELLED", "state after the repeat attempt is identical to state after the first");
  });

  await t.test("10. cancellation audit exists", async () => {
    const s = await scenario("readycancel10");
    const { job, approverSession } = await readyJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const audit = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_CANCELLED' AND target_id=$1", [job.id]);
    assert.equal(audit.rowCount, 1);
  });
});

// ===========================================================================
// RUNNING CANCELLATION (cases 11-20)
// ===========================================================================
test("RUNNING cancellation", async (t) => {
  await t.test("11-12. RUNNING does not become CANCELLED immediately; becomes CANCEL_REQUESTED", async () => {
    const s = await scenario("runcancel1112");
    const { job, requesterSession } = await runningJob(s);
    const cancel = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.status, "CANCEL_REQUESTED", "a RUNNING job soft-cancels, it does not jump straight to CANCELLED");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED");
  });

  await t.test("13. signed Agent status sees cancellation", async () => {
    const s = await scenario("runcancel13");
    const { job, requesterSession } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const status = await statusJob(s.agent, job.id);
    assert.equal(status.status, 200);
    assert.equal(status.body.cancel_requested, true);
  });

  await t.test("14. cancellation remains until Agent confirmation/result", async () => {
    const s = await scenario("runcancel14");
    const { job, requesterSession } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED", "still pending Agent confirmation, no automatic transition to CANCELLED");
  });

  await t.test("15. repeated user cancellation of a CANCEL_REQUESTED job is idempotent", async () => {
    const s = await scenario("runcancel15");
    const { job, requesterSession } = await runningJob(s);
    const first = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    assert.equal(first.status, 200);
    const second = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    assert.equal(second.status, 409, "CANCEL_REQUESTED is not itself re-cancellable; safely refused, no corruption");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED");
  });

  await t.test("16. wrong Agent cannot confirm cancellation", async () => {
    const s = await scenario("runcancel16");
    const otherAgent = await createAgentIdentity(s.org, s.site, "RUNCANCEL16OTHER");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const r = await resultJob(otherAgent, job.id, execution, { exit_code: 1 });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED", "forbidden DB state remains unchanged");
  });

  await t.test("17. wrong execution cannot confirm cancellation", async () => {
    const s = await scenario("runcancel17");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const r = await resultJob(s.agent, job.id, { execution_id: crypto.randomUUID(), execution_capability: execution.execution_capability }, { exit_code: 1 });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED");
  });

  await t.test("18. replayed Agent acknowledgement nonce rejected", async () => {
    const s = await scenario("runcancel18");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const path = `/v1/agent/remote-commands/${job.id}/result`;
    const bodyObj = { execution_id: execution.execution_id, execution_capability: execution.execution_capability, exit_code: 1 };
    const headers = signedHeaders(s.agent, "POST", path, JSON.stringify(bodyObj));
    const first = await call("POST", path, { body: bodyObj, headers });
    assert.equal(first.status, 200);
    const replay = await call("POST", path, { body: bodyObj, headers });
    assert.equal(replay.status, 409);
  });

  await t.test("19. Agent confirmation produces CANCELLED (regardless of reported exit code); 20. audit trail complete", async () => {
    const s = await scenario("runcancel1920");
    const { job, requesterSession, execution } = await runningJob(s);
    const cancelReq = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    assert.equal(cancelReq.status, 200);
    const result = await resultJob(s.agent, job.id, execution, { exit_code: 1, stdout: "terminated by cancellation" });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "CANCELLED", "the Agent's acknowledgement of a pending cancellation always resolves to CANCELLED");
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCELLED");
    assert.ok(row.completed_at);

    const requestedAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_CANCEL_REQUESTED' AND target_id=$1", [job.id]);
    assert.equal(requestedAudit.rowCount, 1, "cancellation requested is audited");
    const confirmedAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_CANCELLED' AND target_id=$1", [job.id]);
    assert.equal(confirmedAudit.rowCount, 1, "cancellation confirmed is audited");
  });
});

// ===========================================================================
// CANCELLATION RACES — RUNNING + cancellation-request vs SUCCEEDED/FAILED/TIMED_OUT
// ===========================================================================
test("Cancellation races", async (t) => {
  async function race(finalOutcome, iterations = 10) {
    let passed = 0;
    for (let i = 0; i < iterations; i++) {
      const s = await scenario(`race${finalOutcome}${i}`);
      const { job, requesterSession, execution } = await runningJob(s);
      const resultPayload = finalOutcome === "TIMED_OUT"
        ? null // TIMED_OUT is produced by maintenance, not a submitted result — raced separately below
        : { exit_code: finalOutcome === "SUCCEEDED" ? 0 : 1, stdout: `race-${finalOutcome}-${i}` };

      const cancelCall = () => call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
      const resultCall = finalOutcome === "TIMED_OUT"
        ? async () => { await pool.query("UPDATE nexora_remote_command_jobs SET started_at = now() - interval '1000 seconds' WHERE id=$1", [job.id]); return reconcileRemoteCommands(); }
        : () => resultJob(s.agent, job.id, execution, resultPayload);

      // Race genuinely: fire both concurrently. Whichever lands first at the
      // DB determines the outcome; the other must be safely rejected/no-op.
      const [cancelResp, resultResp] = await Promise.all([cancelCall(), resultCall()]);

      const row = await jobRow(job.id);
      const terminalStates = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"];
      assert.ok(terminalStates.includes(row.status), `iteration ${i}: job must land in exactly one terminal state, got ${row.status}`);
      // Whichever won, the execution identity must be exactly the one this
      // iteration created — never null, never regenerated, never duplicated.
      assert.equal(row.execution_id, execution.execution_id, `iteration ${i}: execution identity preserved`);
      assert.notEqual(row.status, "READY", `iteration ${i}: no requeue`);
      assert.notEqual(row.status, "CLAIMED", `iteration ${i}: no requeue`);
      void cancelResp; void resultResp;
      passed++;
    }
    return passed;
  }

  let succeededRace = 0, failedRace = 0, timedOutRace = 0;
  await t.test("RUNNING + cancellation vs SUCCEEDED — 10 iterations", async () => { succeededRace = await race("SUCCEEDED", 10); assert.equal(succeededRace, 10); });
  await t.test("RUNNING + cancellation vs FAILED — 10 iterations", async () => { failedRace = await race("FAILED", 10); assert.equal(failedRace, 10); });
  await t.test("RUNNING + cancellation vs TIMED_OUT (maintenance) — 10 iterations", async () => { timedOutRace = await race("TIMED_OUT", 10); assert.equal(timedOutRace, 10); });

  await t.test("no duplicate execution or terminal overwrite across all races", async () => {
    // Spot-check: re-submitting the same accepted result after the race must
    // still be idempotent, never a second execution or a second dispatch.
    const s = await scenario("raceidempotent");
    const { job, requesterSession, execution } = await runningJob(s);
    await Promise.all([
      call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } }),
      resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "raced-success" }),
    ]);
    const before = await jobRow(job.id);
    const retry = await resultJob(s.agent, job.id, execution, before.status === "CANCELLED" ? { exit_code: 1, stdout: "terminated by cancellation" } : { exit_code: 0, stdout: "raced-success" });
    assert.ok([200, 409].includes(retry.status));
    const after = await jobRow(job.id);
    assert.equal(after.execution_id, before.execution_id);
    assert.equal(after.status, before.status);
  });
});

// ===========================================================================
// TERMINAL RESULT MATRIX
// ===========================================================================
test("Terminal result matrix", async (t) => {
  await t.test("SUCCEEDED: status, execution ID, exit code, stdout, stderr, truncation, completed_at", async () => {
    const s = await scenario("matrixsucceeded");
    const { job, execution } = await runningJob(s);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "ok-out", stderr: "ok-err", stdout_truncated: false, stderr_truncated: false });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.status, "SUCCEEDED");
    assert.equal(row.execution_id, execution.execution_id);
    assert.equal(row.exit_code, 0);
    assert.equal(row.stdout, "ok-out");
    assert.equal(row.stderr, "ok-err");
    assert.equal(row.stdout_truncated, false);
    assert.equal(row.stderr_truncated, false);
    assert.ok(row.completed_at);
  });

  await t.test("FAILED: status, exit code, stdout, stderr, truncation, completed_at", async () => {
    const s = await scenario("matrixfailed");
    const { job, execution } = await runningJob(s);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 7, stdout: "partial", stderr: "boom", stdout_truncated: true, stderr_truncated: false });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.status, "FAILED");
    assert.equal(row.exit_code, 7);
    assert.equal(row.stdout, "partial");
    assert.equal(row.stderr, "boom");
    assert.equal(row.stdout_truncated, true);
    assert.equal(row.stderr_truncated, false);
    assert.ok(row.completed_at);
  });

  await t.test("TIMED_OUT: produced by maintenance reconciliation when execution outlives its declared timeout", async () => {
    const s = await scenario("matrixtimedout");
    const { job, execution } = await runningJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET started_at = now() - interval '1000 seconds' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const row = await jobRow(job.id);
    assert.equal(row.status, "TIMED_OUT");
    assert.equal(row.execution_id, execution.execution_id, "execution identity preserved through reconciliation");
    assert.equal(row.failure_code, "EXECUTION_TIMEOUT");
    assert.ok(row.completed_at);
  });

  await t.test("CANCELLED: status, execution ID, completed_at, via Agent acknowledgement", async () => {
    const s = await scenario("matrixcancelled");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 1, stdout: "stopped" });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.execution_id, execution.execution_id);
    assert.ok(row.completed_at);
  });
});

// ===========================================================================
// RESULT IDEMPOTENCY
// ===========================================================================
test("Result idempotency", async (t) => {
  for (const [label, payload] of [
    ["SUCCEEDED", { exit_code: 0, stdout: "idempotent-ok" }],
    ["FAILED", { exit_code: 3, stdout: "idempotent-fail" }],
  ]) {
    await t.test(`identical ${label} result resubmitted with a fresh nonce is a safe no-op`, async () => {
      const s = await scenario(`idem${label}`);
      const { job, execution } = await runningJob(s);
      const first = await resultJob(s.agent, job.id, execution, payload);
      assert.equal(first.status, 200);
      const before = await jobRow(job.id);
      const retry = await resultJob(s.agent, job.id, execution, payload);
      assert.equal(retry.status, 200, "identical retry with a fresh valid nonce is idempotent, not an error");
      const after = await jobRow(job.id);
      assert.equal(after.execution_id, before.execution_id, "execution ID unchanged");
      assert.equal(after.status, before.status, "terminal state unchanged");
      assert.equal(after.execution_attempt, before.execution_attempt, "no duplicate execution / re-claim happened");
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "the row is not rewritten on an identical retry — the command is never rerun");
    });
  }

  await t.test("CANCELLED idempotent retry after Agent acknowledgement", async () => {
    const s = await scenario("idemcancelled");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const payload = { exit_code: 1, stdout: "stopped" };
    const first = await resultJob(s.agent, job.id, execution, payload);
    assert.equal(first.status, 200); assert.equal(first.body.status, "CANCELLED");
    const retry = await resultJob(s.agent, job.id, execution, payload);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "CANCELLED");
  });
});

// ===========================================================================
// CONFLICTING RESULTS
// ===========================================================================
test("Conflicting results", async (t) => {
  async function terminalJob(finalStatus, s) {
    if (finalStatus === "SUCCEEDED" || finalStatus === "FAILED") {
      const { job, execution } = await runningJob(s);
      await resultJob(s.agent, job.id, execution, { exit_code: finalStatus === "SUCCEEDED" ? 0 : 1, stdout: "original" });
      return { job, execution };
    }
    if (finalStatus === "TIMED_OUT") {
      const { job, execution } = await runningJob(s);
      await pool.query("UPDATE nexora_remote_command_jobs SET started_at = now() - interval '1000 seconds' WHERE id=$1", [job.id]);
      await reconcileRemoteCommands();
      return { job, execution };
    }
    // CANCELLED
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    await resultJob(s.agent, job.id, execution, { exit_code: 1, stdout: "cancelled" });
    return { job, execution };
  }

  const conflictCases = [
    ["SUCCEEDED", "FAILED", { exit_code: 1 }],
    ["FAILED", "SUCCEEDED", { exit_code: 0 }],
    ["TIMED_OUT", "SUCCEEDED", { exit_code: 0 }],
    ["CANCELLED", "SUCCEEDED", { exit_code: 0 }],
  ];
  for (const [from, attemptedAs, payload] of conflictCases) {
    await t.test(`${from} -> ${attemptedAs} rejected 409, original immutable`, async () => {
      const s = await scenario(`conflict${from}${attemptedAs}`);
      const { job, execution } = await terminalJob(from, s);
      const before = await jobRow(job.id);
      const attempt = await resultJob(s.agent, job.id, execution, { ...payload, stdout: "conflicting-attempt" });
      assert.equal(attempt.status, 409);
      const after = await jobRow(job.id);
      assert.equal(after.status, before.status, "original terminal status is immutable");
      assert.equal(after.exit_code, before.exit_code);
      assert.equal(after.stdout, before.stdout, "original stdout unchanged — fingerprint unchanged");
      const conflictAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_RESULT_CONFLICT' AND target_id=$1", [job.id]);
      assert.equal(conflictAudit.rowCount, 1);
    });
  }

  await t.test("same terminal status with different stdout is a conflict", async () => {
    const s = await scenario("conflictstdout");
    const { job, execution } = await terminalJob("SUCCEEDED", s);
    const attempt = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "different-output" });
    assert.equal(attempt.status, 409);
  });

  await t.test("same terminal status with different exit code is a conflict", async () => {
    const s = await scenario("conflictexit");
    const { job, execution } = await terminalJob("SUCCEEDED", s);
    const attempt = await resultJob(s.agent, job.id, execution, { exit_code: 99, stdout: "original" });
    assert.equal(attempt.status, 409);
  });

  await t.test("no requeue, no new execution after any conflict", async () => {
    const s = await scenario("conflictnorequeue");
    const { job, execution } = await terminalJob("FAILED", s);
    await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "conflicting" });
    const row = await jobRow(job.id);
    assert.equal(row.execution_id, execution.execution_id);
    assert.equal(row.execution_attempt, 1);
    const reclaim = await claimJob(s.agent);
    assert.equal(reclaim.status, 204, "a terminal job never becomes reclaimable because of a conflict");
  });
});

// ===========================================================================
// OUTPUT PERSISTENCE
// ===========================================================================
test("Output persistence", async (t) => {
  await t.test("Unicode stdout/stderr round-trip and streams stay separate", async () => {
    const s = await scenario("unicode");
    const { job, execution } = await runningJob(s);
    const stdout = "héllo wörld 你好 🎉 — done";
    const stderr = "erreur: café ☃ ☃";
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout, stderr });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.stdout, stdout);
    assert.equal(row.stderr, stderr);
    assert.notEqual(row.stdout, row.stderr);
  });

  await t.test("empty output is accepted and persisted as empty, not null-confused", async () => {
    const s = await scenario("emptyoutput");
    const { job, execution } = await runningJob(s);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "", stderr: "" });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.stdout, "");
    assert.equal(row.stderr, "");
  });

  await t.test("truncation flags persist independently of content", async () => {
    const s = await scenario("truncflags");
    const { job, execution } = await runningJob(s);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: "short", stderr: "short", stdout_truncated: true, stderr_truncated: false });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.stdout_truncated, true);
    assert.equal(row.stderr_truncated, false);
  });

  await t.test("max permitted output (1MB) is accepted", async () => {
    const s = await scenario("maxoutput");
    const { job, execution } = await runningJob(s);
    const big = "x".repeat(1024 * 1024);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: big, stdout_truncated: true });
    assert.equal(r.status, 200);
    const row = await jobRow(job.id);
    assert.equal(row.stdout.length, big.length);
  });

  await t.test("oversized output is rejected safely (400), not silently truncated server-side", async () => {
    const s = await scenario("oversizedoutput");
    const { job, execution } = await runningJob(s);
    const tooBig = "x".repeat(1024 * 1024 + 1);
    const r = await resultJob(s.agent, job.id, execution, { exit_code: 0, stdout: tooBig });
    assert.equal(r.status, 400);
    const row = await jobRow(job.id);
    assert.equal(row.status, "RUNNING", "the job is untouched by a rejected oversized submission");
  });
});

// ===========================================================================
// LEASE SAFETY
// ===========================================================================
test("Lease safety", async (t) => {
  await t.test("CLAIMED lease exists; RUNNING lease exists; heartbeat extends it", async () => {
    const s = await scenario("lease1");
    const { job, requesterSession, approverSession } = await readyJob(s);
    const claim = await claimJob(s.agent);
    assert.equal(claim.status, 200);
    const claimedRow = await jobRow(job.id);
    assert.ok(claimedRow.lease_expires_at, "CLAIMED lease exists");
    const start = await startJob(s.agent, job.id, claim.body);
    assert.equal(start.status, 200);
    const runningRow = await jobRow(job.id);
    assert.ok(runningRow.lease_expires_at, "RUNNING lease exists");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const hb = await heartbeatJob(s.agent, job.id, claim.body);
    assert.equal(hb.status, 200);
    const afterHb = await jobRow(job.id);
    assert.ok(new Date(afterHb.lease_expires_at).getTime() > new Date(runningRow.lease_expires_at).getTime());
    void requesterSession; void approverSession;
  });

  await t.test("wrong execution cannot extend lease", async () => {
    const s = await scenario("lease2");
    const { job, execution } = await runningJob(s);
    const before = await jobRow(job.id);
    const path = `/v1/agent/remote-commands/${job.id}/heartbeat`;
    const r = await signedCall(s.agent, "POST", path, { execution_id: crypto.randomUUID(), execution_capability: execution.execution_capability });
    assert.equal(r.status, 404);
    const after = await jobRow(job.id);
    assert.equal(after.lease_expires_at.getTime(), before.lease_expires_at.getTime());
  });

  await t.test("wrong Agent cannot extend lease", async () => {
    const s = await scenario("lease3");
    const otherAgent = await createAgentIdentity(s.org, s.site, "LEASE3OTHER");
    const { job, execution } = await runningJob(s);
    const before = await jobRow(job.id);
    const r = await heartbeatJob(otherAgent, job.id, execution);
    assert.equal(r.status, 404);
    const after = await jobRow(job.id);
    assert.equal(after.lease_expires_at.getTime(), before.lease_expires_at.getTime());
  });

  await t.test("replayed heartbeat cannot extend lease twice", async () => {
    const s = await scenario("lease4");
    const { job, execution } = await runningJob(s);
    const path = `/v1/agent/remote-commands/${job.id}/heartbeat`;
    const bodyObj = { execution_id: execution.execution_id, execution_capability: execution.execution_capability };
    const headers = signedHeaders(s.agent, "POST", path, JSON.stringify(bodyObj));
    const first = await call("POST", path, { body: bodyObj, headers });
    assert.equal(first.status, 200);
    const afterFirst = await jobRow(job.id);
    const replay = await call("POST", path, { body: bodyObj, headers });
    assert.equal(replay.status, 409);
    const afterReplay = await jobRow(job.id);
    assert.equal(afterReplay.lease_expires_at.getTime(), afterFirst.lease_expires_at.getTime(), "the replayed heartbeat did not extend the lease again");
  });

  await t.test("terminal job cannot be resurrected via heartbeat", async () => {
    const s = await scenario("lease5");
    const { job, execution } = await runningJob(s);
    await resultJob(s.agent, job.id, execution, { exit_code: 0 });
    const hb = await heartbeatJob(s.agent, job.id, execution);
    assert.equal(hb.status, 409);
    const row = await jobRow(job.id);
    assert.equal(row.status, "SUCCEEDED");
  });
});

// ===========================================================================
// STALE CLAIMED -> reconciliation
// ===========================================================================
test("Stale CLAIMED reconciliation", async (t) => {
  await t.test("expired CLAIMED lease reconciles safely to UNKNOWN, no rerun, no new execution", async () => {
    const s = await scenario("staleclaimed");
    const { job } = await readyJob(s);
    const claim = await claimJob(s.agent);
    assert.equal(claim.status, 200);
    await pool.query("UPDATE nexora_remote_command_jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const row = await jobRow(job.id);
    assert.equal(row.status, "UNKNOWN");
    assert.equal(row.execution_id, claim.body.execution_id, "execution ID preserved, not regenerated");
    assert.equal(row.execution_attempt, 1, "no new execution authorization was created");
    const reclaim = await claimJob(s.agent);
    assert.equal(reclaim.status, 204, "UNKNOWN is never automatically re-issued as READY / re-claimable");
  });
});

// ===========================================================================
// STALE RUNNING -> UNKNOWN
// ===========================================================================
test("Stale RUNNING reconciliation to UNKNOWN", async (t) => {
  await t.test("ambiguous execution never auto-reruns: heartbeat gap -> UNKNOWN, stable, unclaimable", async () => {
    const s = await scenario("stalerunning");
    const { job, execution } = await runningJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET last_execution_heartbeat_at = now() - interval '121 seconds' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const row = await jobRow(job.id);
    assert.equal(row.status, "UNKNOWN");
    assert.equal(row.execution_id, execution.execution_id, "execution ID preserved");

    const claim = await claimJob(s.agent);
    assert.equal(claim.status, 204, "UNKNOWN cannot be claimed");

    const startAttempt = await startJob(s.agent, job.id, execution);
    assert.equal(startAttempt.status, 409, "UNKNOWN cannot be started");

    // Repeated reconciliation is stable: no further transition, no rerun.
    await reconcileRemoteCommands();
    await reconcileRemoteCommands();
    const stableRow = await jobRow(job.id);
    assert.equal(stableRow.status, "UNKNOWN");
    assert.equal(stableRow.execution_id, execution.execution_id);
    assert.equal(stableRow.updated_at.getTime(), row.updated_at.getTime(), "repeated reconciliation does not touch an already-UNKNOWN row again");
  });

  await t.test("UNKNOWN reconciliation is audited", async () => {
    const s = await scenario("stalerunningaudit");
    const { job } = await runningJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET last_execution_heartbeat_at = now() - interval '121 seconds' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const audit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_UNKNOWN' AND target_id=$1", [job.id]);
    assert.equal(audit.rowCount, 1);
  });
});

// ===========================================================================
// READY EXPIRY
// ===========================================================================
test("READY expiry", async (t) => {
  await t.test("READY expires after its TTL, becomes EXPIRED, cannot be claimed, no auto-return to READY, audited", async () => {
    const s = await scenario("readyexpiry");
    const { job } = await readyJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET expires_at = now() - interval '1 second' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const row = await jobRow(job.id);
    assert.equal(row.status, "EXPIRED");

    const claim = await claimJob(s.agent);
    assert.equal(claim.status, 204, "an expired job is never claimed");

    await reconcileRemoteCommands();
    const stillExpired = await jobRow(job.id);
    assert.equal(stillExpired.status, "EXPIRED", "EXPIRED never automatically reverts to READY");

    const audit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_EXPIRED' AND target_id=$1", [job.id]);
    assert.equal(audit.rowCount, 1);
  });
});

// ===========================================================================
// RESTART AMBIGUITY / RESULT AFTER RESTART
// ===========================================================================
test("Restart ambiguity and result-after-restart", async (t) => {
  async function restartApp() {
    // All execution state lives in PostgreSQL, not in the Express process, so
    // a restart is exactly this: tear down the app, stand up a brand new one,
    // and prove nothing about the running job changed or duplicated.
    await new Promise((resolve) => server.close(resolve));
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  }

  await t.test("RUNNING execution is not duplicated or requeued across a server restart", async () => {
    const s = await scenario("restart1");
    const { job, execution } = await runningJob(s);
    const before = await jobRow(job.id);
    await restartApp();
    const after = await jobRow(job.id);
    assert.equal(after.status, "RUNNING", "no automatic requeue happened purely from the process restarting");
    assert.equal(after.execution_id, before.execution_id, "execution ID preserved across restart");
    assert.equal(after.execution_attempt, before.execution_attempt, "no second dispatch / second execution capability was created");

    // A legitimate, still-valid signed heartbeat against the new process
    // instance must work exactly as before restart.
    const hb = await heartbeatJob(s.agent, job.id, execution);
    assert.equal(hb.status, 200);
  });

  await t.test("a genuinely stale RUNNING execution (as if the Agent died mid-restart) still reconciles to UNKNOWN, never auto-rerun", async () => {
    const s = await scenario("restart2");
    const { job, execution } = await runningJob(s);
    await restartApp();
    await pool.query("UPDATE nexora_remote_command_jobs SET last_execution_heartbeat_at = now() - interval '121 seconds' WHERE id=$1", [job.id]);
    await reconcileRemoteCommands();
    const row = await jobRow(job.id);
    assert.equal(row.status, "UNKNOWN");
    assert.equal(row.execution_id, execution.execution_id);
    const reclaim = await claimJob(s.agent);
    assert.equal(reclaim.status, 204, "no automatic requeue / rerun after the ambiguous execution");
  });

  await t.test("Agent retries its result after a restart: legitimate first submission accepted, identical retry idempotent, conflicting retry 409", async () => {
    const s = await scenario("restart3");
    const { job, execution } = await runningJob(s);
    await restartApp();
    const payload = { exit_code: 0, stdout: "completed-before-restart-noticed" };
    const first = await resultJob(s.agent, job.id, execution, payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.execution_id ?? execution.execution_id, execution.execution_id);

    const retry = await resultJob(s.agent, job.id, execution, payload);
    assert.equal(retry.status, 200, "identical retry after restart is idempotent");

    const conflicting = await resultJob(s.agent, job.id, execution, { exit_code: 1, stdout: "different" });
    assert.equal(conflicting.status, 409, "a conflicting retry after restart is rejected, not silently accepted");

    const row = await jobRow(job.id);
    assert.equal(row.execution_id, execution.execution_id, "execution identity survives the restart end to end");
    assert.equal(row.status, "SUCCEEDED");
  });
});

// ===========================================================================
// MAINTENANCE CONCURRENCY
// ===========================================================================
test("Maintenance concurrency", async (t) => {
  await t.test("10 concurrent reconciliation workers converge to one deterministic final state each, no duplicates", async () => {
    for (let i = 0; i < 10; i++) {
      const s = await scenario(`maint${i}`);
      const { job } = await runningJob(s);
      await pool.query("UPDATE nexora_remote_command_jobs SET last_execution_heartbeat_at = now() - interval '121 seconds' WHERE id=$1", [job.id]);

      const results = await Promise.all(Array.from({ length: 8 }, () => reconcileRemoteCommands()));
      const totalStaleTransitions = results.reduce((sum, r) => sum + r.stale, 0);
      // Across 8 concurrent workers, exactly one of them may have been the one
      // that actually flipped this specific row (others may report 0 for it,
      // or pick up unrelated rows from other iterations' leftovers — so this
      // asserts the row itself, not merely the aggregate counter).
      const row = await jobRow(job.id);
      assert.equal(row.status, "UNKNOWN", `iteration ${i}: deterministic final state`);
      void totalStaleTransitions;

      const auditRows = await pool.query("SELECT count(*)::int AS n FROM nexora_audit_log WHERE action='REMOTE_COMMAND_UNKNOWN' AND target_id=$1", [job.id]);
      assert.equal(auditRows.rows[0].n, 1, `iteration ${i}: exactly one audit row, no duplicate/corrupt audit`);

      const claim = await claimJob(s.agent);
      assert.equal(claim.status, 204, `iteration ${i}: no requeue after concurrent reconciliation`);
    }
  });
});

// ===========================================================================
// TENANT ISOLATION
// ===========================================================================
test("Tenant isolation for terminal operations", async (t) => {
  await t.test("Org A cannot cancel Org B's job", async () => {
    const a = await scenario("tenantA1");
    const b = await scenario("tenantB1");
    const { job } = await readyJob(b);
    const aSession = await login(a.approver);
    const r = await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: aSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": aSession.csrf } });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "READY");
  });

  await t.test("Org A cannot view Org B's results", async () => {
    const a = await scenario("tenantA2");
    const b = await scenario("tenantB2");
    const { job, execution } = await runningJob(b);
    await resultJob(b.agent, job.id, execution, { exit_code: 0, stdout: "org-b-secret-output" });
    const aSession = await login(a.approver);
    const r = await call("GET", `/v1/remote-commands/${job.id}`, { cookie: aSession.cookie });
    assert.equal(r.status, 404);
  });

  await t.test("Agent A cannot submit Org B's result", async () => {
    const a = await scenario("tenantA3");
    const b = await scenario("tenantB3");
    const { job, execution } = await runningJob(b);
    const r = await resultJob(a.agent, job.id, execution, { exit_code: 0 });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "RUNNING");
  });

  await t.test("Agent A cannot acknowledge Org B's cancellation", async () => {
    const a = await scenario("tenantA4");
    const b = await scenario("tenantB4");
    const { job, requesterSession, execution } = await runningJob(b);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    const r = await resultJob(a.agent, job.id, execution, { exit_code: 1 });
    assert.equal(r.status, 404);
    const row = await jobRow(job.id);
    assert.equal(row.status, "CANCEL_REQUESTED");
  });

  await t.test("Agent A cannot heartbeat Org B's execution", async () => {
    const a = await scenario("tenantA5");
    const b = await scenario("tenantB5");
    const { job, execution } = await runningJob(b);
    const r = await heartbeatJob(a.agent, job.id, execution);
    assert.equal(r.status, 404);
  });

  await t.test("cross-tenant job IDs do not leak data (safe 404, no field disclosure)", async () => {
    const a = await scenario("tenantA6");
    const b = await scenario("tenantB6");
    const { job, execution } = await runningJob(b);
    await resultJob(b.agent, job.id, execution, { exit_code: 0, stdout: "org-b-only-data" });
    const aSession = await login(a.approver);
    const r = await call("GET", `/v1/remote-commands/${job.id}`, { cookie: aSession.cookie });
    assert.equal(r.status, 404);
    assert.ok(!r.rawText.includes("org-b-only-data"));
  });
});

// ===========================================================================
// AUDIT
// ===========================================================================
test("Audit evidence for the full lifecycle", async (t) => {
  await t.test("cancellation requested, accepted terminal results, result conflict, expiry, UNKNOWN reconciliation, security rejections all leave audit rows", async () => {
    const s = await scenario("auditall");
    // Accepted terminal result (SUCCEEDED).
    const succeeded = await scenario("auditsucceeded");
    const { job: sJob, execution: sExec } = await runningJob(succeeded);
    await resultJob(succeeded.agent, sJob.id, sExec, { exit_code: 0 });
    const succeededAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_SUCCEEDED' AND target_id=$1", [sJob.id]);
    assert.equal(succeededAudit.rowCount, 1, "accepted terminal result (SUCCEEDED) is audited");

    // Result conflict.
    const conflictAttempt = await resultJob(succeeded.agent, sJob.id, sExec, { exit_code: 1 });
    assert.equal(conflictAttempt.status, 409);
    const conflictAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_RESULT_CONFLICT' AND target_id=$1", [sJob.id]);
    assert.equal(conflictAudit.rowCount, 1, "result conflict is audited");

    // Expiry.
    const { job: expJob } = await readyJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET expires_at = now() - interval '1 second' WHERE id=$1", [expJob.id]);
    await reconcileRemoteCommands();
    const expiryAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_EXPIRED' AND target_id=$1", [expJob.id]);
    assert.equal(expiryAudit.rowCount, 1, "expiry is audited");

    // UNKNOWN reconciliation.
    const { job: runJob } = await runningJob(s);
    await pool.query("UPDATE nexora_remote_command_jobs SET last_execution_heartbeat_at = now() - interval '121 seconds' WHERE id=$1", [runJob.id]);
    await reconcileRemoteCommands();
    const unknownAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_UNKNOWN' AND target_id=$1", [runJob.id]);
    assert.equal(unknownAudit.rowCount, 1, "UNKNOWN reconciliation is audited");

    // Security failure (replay rejection) still audited per the existing Task010 fix.
    const path = "/v1/agent/remote-commands/claim";
    const headers = signedHeaders(s.agent, "POST", path, "{}");
    await call("POST", path, { body: {}, headers });
    const replay = await call("POST", path, { body: {}, headers });
    assert.equal(replay.status, 409);
    const replayAudit = await pool.query("SELECT 1 FROM nexora_audit_log WHERE action='REMOTE_COMMAND_REPLAY_REJECTED' AND organization_id=$1 ORDER BY 1 DESC LIMIT 1", [s.org]);
    assert.equal(replayAudit.rowCount, 1, "replay rejection is audited");
  });
});

// ===========================================================================
// REDACTION
// ===========================================================================
test("Redaction across the full lifecycle", async (t) => {
  await t.test("no secret sentinel leaks through audit metadata, error bodies, or persisted generic metadata", async () => {
    const s = await scenario("redactionv");
    const { job, requesterSession, execution } = await runningJob(s);
    await call("POST", `/v1/remote-commands/${job.id}/cancel`, { cookie: requesterSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": requesterSession.csrf } });
    await resultJob(s.agent, job.id, execution, { exit_code: 1, stdout: `output mentioning ${SENTINELS.executionCapability} label only, not the real value` });

    const failedAuth = await call("POST", "/v1/agent/remote-commands/claim", { body: {}, headers: { authorization: `Bearer wrong-${SENTINELS.agentBearer}` } });
    assert.equal(failedAuth.status, 401);
    assert.ok(!failedAuth.rawText.includes(s.agent.token));
    assert.ok(!failedAuth.rawText.includes(SENTINELS.agentBearer) || failedAuth.rawText === "");

    const auditRows = await pool.query("SELECT metadata::text AS metadata, action FROM nexora_audit_log WHERE organization_id=$1", [s.org]);
    for (const row of auditRows.rows) {
      const text = row.metadata ?? "";
      assert.ok(!text.includes(s.agent.token), `audit metadata for ${row.action} must not contain the raw agent bearer token`);
      assert.ok(!text.includes(SENTINELS.privateKey), `audit metadata for ${row.action} must not contain a private-key sentinel`);
    }

    const jobRowText = await pool.query("SELECT command_payload::text AS payload FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.ok(!jobRowText.rows[0].payload.includes(s.agent.token));

    const keyRow = await pool.query("SELECT public_key FROM nexora_agent_signing_keys WHERE device_id=$1", [s.agent.device]);
    assert.ok(!keyRow.rows[0].public_key.includes("PRIVATE"), "the private key is never persisted");
  });
});
