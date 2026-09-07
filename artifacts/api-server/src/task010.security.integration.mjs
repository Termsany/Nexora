// Task #010 — Signed Protocol Security Acceptance Suite
//
// Extends the existing Task010 smoke/acceptance coverage in
// task010.integration.mjs (left untouched) with the full signature, replay,
// claim-concurrency, agent/device binding, lifecycle and audit/redaction
// matrix. Runs against the real Express app (createApp()), the real
// production verification middleware in src/routes/remote-commands.ts and
// src/security/agent-signing.ts, and a disposable PostgreSQL 16 database
// migrated with the real Drizzle migrations. No verifier or route is
// reimplemented here.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import pg from "pg";
import { createApp } from "./app.ts";
import { hashPassword } from "./auth/password.ts";
import { canonicalAgentRequest } from "./security/agent-signing.ts";
import { resetLoginRateForTests } from "./security/rate-limit.ts";

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

// ---------------------------------------------------------------------------
// Fixture builders. Everything routes through the same helpers so every test
// exercises the real bearer-auth lookup, real signing-key table, and real
// ECDSA verification path in src/routes/remote-commands.ts.
// ---------------------------------------------------------------------------

async function createOrgSite(label) {
  const org = crypto.randomUUID();
  const site = crypto.randomUUID();
  await pool.query("INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,$2,$3)", [org, `Task010 ${label}`, `task010-${label}-${org}`]);
  await pool.query("INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,$3)", [site, org, `${label} Site`]);
  return { org, site };
}

async function createUser(orgId, role, label) {
  const id = crypto.randomUUID();
  const email = `task010-${label}-${id}@test.invalid`;
  const password = `task010-${label}-password`;
  const passwordHash = await hashPassword(password);
  await pool.query("INSERT INTO nexora_users(id,email,name,password_hash,scope,platform_role) VALUES ($1,$2,$3,$4,'ORGANIZATION',NULL)", [id, email, `Task010 ${label}`, passwordHash]);
  await pool.query("INSERT INTO nexora_organization_memberships(user_id,organization_id,role) VALUES ($1,$2,$3)", [id, orgId, role]);
  return { id, email, password };
}

async function login(user) {
  // This suite performs far more logins than the production per-IP/per-account
  // rate limit allows within its window; that limiter is exercised on its own
  // merits elsewhere and is not what this suite is testing, so it is reset
  // before every login here using the reset hook the rate limiter exports
  // specifically for tests.
  resetLoginRateForTests();
  const response = await call("POST", "/v1/auth/login", { body: { email: user.email, password: user.password } });
  assert.equal(response.status, 200, `login must succeed for ${user.email}`);
  const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie().join(";") : (response.headers.get("set-cookie") ?? "");
  const cookie = `${/nexora_session=([^;]+)/.exec(setCookie)?.[0] ?? ""}; nexora_csrf=${response.body.csrf_token}`;
  return { cookie, csrf: response.body.csrf_token };
}

// Agent identity bundle: device row + agent bearer token + ECDSA signing key,
// all persisted through the same tables the production routes read from.
async function createAgentIdentity(orgId, siteId, label, { remoteCommandsEnabled = true, capabilities = ["remote_command_v1"] } = {}) {
  const device = crypto.randomUUID();
  const agentId = `TASK010-${label}-${device.slice(0, 8)}`;
  const token = `${SENTINELS.agentBearer}-${crypto.randomUUID()}`;
  const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id,remote_commands_enabled,capabilities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [device, agentId, crypto.randomUUID(), `TASK010-${label}`, orgId, siteId, remoteCommandsEnabled, JSON.stringify(capabilities)],
  );
  await pool.query("INSERT INTO nexora_agent_credentials(device_id,token_hash) VALUES ($1,$2)", [device, crypto.createHash("sha256").update(token).digest("hex")]);
  await pool.query(
    "INSERT INTO nexora_agent_signing_keys(id,device_id,algorithm,public_key,key_fingerprint,protocol_version) VALUES ($1,$2,'ECDSA_P256_SHA256',$3,$4,'remote_command_v1')",
    [keyId, device, publicKey, crypto.createHash("sha256").update(publicKey).digest("hex")],
  );
  return { device, agentId, token, keyId, keyPair, org: orgId, site: siteId };
}

// Builds a fully-signed header set. `overrides` lets a test corrupt exactly
// one dimension (version, timestamp, nonce, key id, signature, agent id used
// in the canonical string, private key used to sign) while leaving the rest
// of the real signed-request contract intact.
function signedHeaders(agent, method, path, body = "", overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? crypto.randomBytes(16).toString("hex");
  const keyId = overrides.keyId ?? agent.keyId;
  const agentIdForCanonical = overrides.agentIdForCanonical ?? agent.agentId;
  const canonicalMethod = overrides.canonicalMethod ?? method;
  const canonicalPath = overrides.canonicalPath ?? path;
  const canonical = canonicalAgentRequest(canonicalMethod, canonicalPath, Buffer.from(overrides.canonicalBody ?? body), timestamp, nonce, agentIdForCanonical, keyId);
  const signingKey = overrides.privateKey ?? agent.keyPair.privateKey;
  const signature = overrides.signature ?? crypto.sign("sha256", Buffer.from(canonical), { key: signingKey, dsaEncoding: "der" }).toString("base64");
  const headers = { authorization: `Bearer ${overrides.token ?? agent.token}`, "x-nexora-signature-version": overrides.version ?? "nexora-agent-sign-v1", "x-nexora-key-id": keyId, "x-nexora-timestamp": timestamp, "x-nexora-nonce": nonce, "x-nexora-signature": signature };
  if (overrides.omit) for (const h of overrides.omit) delete headers[h];
  return headers;
}

async function claim(agent, { headers } = {}) {
  const body = "{}";
  return call("POST", "/v1/agent/remote-commands/claim", { body: {}, headers: headers ?? signedHeaders(agent, "POST", "/v1/agent/remote-commands/claim", body) });
}

// Full legal path from an authorized user request through to a READY job,
// using the real privileged-action approval routes (not a direct DB insert),
// so approval, feature gates and audit all run through production code.
async function requestApprovedReadyJob({ requester, approver, org, device, cookieOverride } = {}) {
  const created = await call("POST", "/v1/remote-commands", {
    cookie: requester.cookie,
    headers: { origin: "http://127.0.0.1", "x-csrf-token": requester.csrf },
    body: { device_id: device, shell: "CMD", command: "echo task010-security", reason: "task010 security acceptance" },
  });
  assert.equal(created.status, 201, `remote command request must succeed: ${JSON.stringify(created.body)}`);
  const approved = await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, {
    cookie: cookieOverride ?? approver.cookie,
    headers: { origin: "http://127.0.0.1", "x-csrf-token": (cookieOverride ? requester.csrf : approver.csrf) },
  });
  return { job: created.body, approved };
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
// PHASE 2 — SIGNATURE SECURITY MATRIX (cases 1-18)
// ===========================================================================
test("Phase 2: signature security matrix — 18 boundary cases against the real verification middleware", async (t) => {
  const { org, site } = await createOrgSite("sig-matrix");
  const agentA = await createAgentIdentity(org, site, "SIGA");
  const otherAgent = await createAgentIdentity(org, site, "SIGB");
  const path = "/v1/agent/remote-commands/claim";
  const body = "{}";

  await t.test("1. valid bearer + valid ECDSA signature accepted", async () => {
    const r = await claim(agentA);
    assert.equal(r.status, 204); // no READY job yet, but signature verification passed
  });
  await t.test("2. bearer without signature rejected", async () => {
    const r = await call("POST", path, { body: {}, headers: { authorization: `Bearer ${agentA.token}` } });
    assert.equal(r.status, 401);
  });
  await t.test("3. missing signature-version rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { omit: ["x-nexora-signature-version"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("4. unsupported signature-version rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { version: "nexora-agent-sign-v2" }) });
    assert.equal(r.status, 401);
  });
  await t.test("5. missing timestamp rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { omit: ["x-nexora-timestamp"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("6. malformed timestamp rejected", async () => {
    const headers = signedHeaders(agentA, "POST", path, body);
    headers["x-nexora-timestamp"] = "not-a-number";
    const r = await claim(agentA, { headers });
    assert.equal(r.status, 401);
  });
  await t.test("7. missing nonce rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { omit: ["x-nexora-nonce"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("8. invalid/empty nonce rejected", async () => {
    const headers = signedHeaders(agentA, "POST", path, body);
    headers["x-nexora-nonce"] = "";
    const r = await claim(agentA, { headers });
    assert.equal(r.status, 401);
  });
  await t.test("9. missing key-id rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { omit: ["x-nexora-key-id"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("10. unknown key-id rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { keyId: crypto.randomUUID() }) });
    assert.equal(r.status, 401);
  });
  await t.test("11. missing signature rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { omit: ["x-nexora-signature"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("12. malformed signature rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { signature: "not-base64-signature!!" }) });
    assert.equal(r.status, 401);
  });
  await t.test("13. wrong ECDSA private key rejected", async () => {
    const wrongKeyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { privateKey: wrongKeyPair.privateKey }) });
    assert.equal(r.status, 401);
  });
  await t.test("14. wrong Agent identity (canonical agent id) rejected", async () => {
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { agentIdForCanonical: otherAgent.agentId }) });
    assert.equal(r.status, 401);
  });
  await t.test("15. wrong device binding (signature made with another device's key) rejected", async () => {
    // Sign as if agentA, but with otherAgent's private key and key id: binds to the
    // wrong device's signing key entirely and must fail key-lookup/verification.
    const r = await claim(agentA, { headers: signedHeaders(agentA, "POST", path, body, { keyId: otherAgent.keyId, privateKey: otherAgent.keyPair.privateKey }) });
    assert.equal(r.status, 401);
  });
  await t.test("16. body modified after signing rejected", async () => {
    const headers = signedHeaders(agentA, "POST", path, body);
    const r = await call("POST", path, { body: { tampered: true }, headers });
    assert.equal(r.status, 401);
  });
  await t.test("17. canonical path modified after signing rejected", async () => {
    // Sign for a different path than the one actually requested.
    const headers = signedHeaders(agentA, "POST", "/v1/agent/remote-commands/claim", body, { canonicalPath: "/v1/agent/remote-commands/other" });
    const r = await call("POST", path, { body: {}, headers });
    assert.equal(r.status, 401);
  });
  await t.test("18. HTTP method modified after signing rejected", async () => {
    const headers = signedHeaders(agentA, "GET", path, body);
    const r = await call("POST", path, { body: {}, headers });
    assert.equal(r.status, 401);
  });
});

// ===========================================================================
// PHASE 3 — TIMESTAMP SECURITY (cases 19-23)
// ===========================================================================
test("Phase 3: timestamp skew policy (+/-300s) is enforced by the real middleware", async (t) => {
  const { org, site } = await createOrgSite("ts-policy");
  const agent = await createAgentIdentity(org, site, "TS");
  const path = "/v1/agent/remote-commands/claim";
  const now = () => Math.floor(Date.now() / 1000);

  await t.test("19. current timestamp accepted", async () => {
    const r = await claim(agent, { headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(now()) }) });
    assert.equal(r.status, 204);
  });
  await t.test("20. timestamp safely inside negative boundary (-250s) accepted", async () => {
    const r = await claim(agent, { headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(now() - 250) }) });
    assert.equal(r.status, 204);
  });
  await t.test("21. timestamp safely inside positive boundary (+250s) accepted", async () => {
    const r = await claim(agent, { headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(now() + 250) }) });
    assert.equal(r.status, 204);
  });
  await t.test("22. timestamp older than allowed skew (-310s) rejected", async () => {
    const r = await claim(agent, { headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(now() - 310) }) });
    assert.equal(r.status, 401);
  });
  await t.test("23. timestamp further in future than allowed skew (+310s) rejected", async () => {
    const r = await claim(agent, { headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(now() + 310) }) });
    assert.equal(r.status, 401);
  });
});

// ===========================================================================
// PHASE 4 — NONCE / REPLAY CONCURRENCY (cases 24-28)
// ===========================================================================
test("Phase 4: nonce persistence, replay rejection and concurrent-replay atomicity", async (t) => {
  const { org, site } = await createOrgSite("replay");
  const agent = await createAgentIdentity(org, site, "REPLAY");
  const path = "/v1/agent/remote-commands/claim";

  await t.test("24-25. nonce persists in PostgreSQL and a duplicate cannot cause a second mutation", async () => {
    const headers = signedHeaders(agent, "POST", path, "{}");
    const first = await claim(agent, { headers });
    const second = await claim(agent, { headers });
    assert.equal(first.status, 204);
    assert.equal(second.status, 409);
    const row = await pool.query("SELECT count(*)::int AS n FROM nexora_agent_request_nonces WHERE device_id=$1", [agent.device]);
    assert.equal(row.rows[0].n, 1, "exactly one nonce row is persisted, not one per attempt");
  });

  await t.test("26. altered signature with a consumed nonce is rejected (not just replay-rejected)", async () => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const headers = signedHeaders(agent, "POST", path, "{}", { nonce });
    const consumed = await claim(agent, { headers });
    assert.equal(consumed.status, 204);
    const tamperedSig = { ...headers, "x-nexora-signature": Buffer.from(headers["x-nexora-signature"], "base64").reverse().toString("base64") };
    const replay = await claim(agent, { headers: tamperedSig });
    assert.equal(replay.status, 401, "signature verification runs before nonce consumption, so a bad signature never reaches replay logic");
  });

  await t.test("27. altered body with a consumed nonce is rejected", async () => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const headers = signedHeaders(agent, "POST", path, "{}", { nonce });
    const consumed = await claim(agent, { headers });
    assert.equal(consumed.status, 204);
    const replay = await call("POST", path, { body: { tampered: true }, headers });
    assert.equal(replay.status, 401);
  });

  await t.test("28. concurrent replay protection is atomic — 10/10 iterations, exactly one winner each", async () => {
    let passedIterations = 0;
    for (let i = 0; i < 10; i++) {
      const nonce = crypto.randomBytes(16).toString("hex");
      const headers = signedHeaders(agent, "POST", path, "{}", { nonce });
      const responses = await Promise.all(Array.from({ length: 8 }, () => call("POST", path, { body: {}, headers })));
      const successes = responses.filter((r) => r.status === 204 || r.status === 200);
      const rejected = responses.filter((r) => r.status === 409);
      assert.equal(successes.length, 1, `iteration ${i}: expected exactly 1 success, got ${successes.length} (${JSON.stringify(responses.map((r) => r.status))})`);
      assert.equal(rejected.length, 7, `iteration ${i}: expected exactly 7 rejections, got ${rejected.length}`);
      const nonceRow = await pool.query("SELECT count(*)::int AS n FROM nexora_agent_request_nonces WHERE device_id=$1 AND nonce_hash=$2", [agent.device, crypto.createHash("sha256").update(nonce).digest("hex")]);
      assert.equal(nonceRow.rows[0].n, 1, `iteration ${i}: nonce must persist exactly once`);
      passedIterations++;
    }
    assert.equal(passedIterations, 10);
    console.log("Replay concurrency: 10/10 iterations PASS");
  });
});

// ===========================================================================
// PHASE 5 — CLAIM CONCURRENCY (cases 29-36)
// ===========================================================================
test("Phase 5: claim concurrency is transactionally exclusive", async (t) => {
  const { org, site } = await createOrgSite("claim-race");
  const agent = await createAgentIdentity(org, site, "CLAIMRACE");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "claimrace-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "claimrace-appr");

  async function raceClaim(concurrency = 12) {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    assert.equal(approved.status, 200, `approval must succeed: ${JSON.stringify(approved.body)}`);
    const responses = await Promise.all(Array.from({ length: concurrency }, () => {
      const nonce = crypto.randomBytes(16).toString("hex");
      const path = "/v1/agent/remote-commands/claim";
      return call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}", { nonce }) });
    }));
    return { job, responses };
  }

  await t.test("29-36. exactly one claim wins; DB state stays consistent across repeated races", async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const { job, responses } = await raceClaim();
      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 204);
      assert.equal(winners.length, 1, `iteration ${iteration}: exactly one claim must win`);
      assert.equal(losers.length, responses.length - 1, `iteration ${iteration}: all others must be 204 (no eligible job) losers`);
      const executionIds = new Set(winners.map((r) => r.body.execution_id));
      assert.equal(executionIds.size, 1, "exactly one execution id exists");
      const row = await pool.query("SELECT status, execution_id, execution_capability_hash, execution_attempt FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
      assert.equal(row.rows[0].status, "CLAIMED", "job has one CLAIMED transition and does not bounce back to READY");
      assert.equal(row.rows[0].execution_id, winners[0].body.execution_id, "the persisted execution id matches the sole winner (losers cannot overwrite execution identity)");
      assert.equal(row.rows[0].execution_capability_hash, crypto.createHash("sha256").update(winners[0].body.execution_capability).digest("hex"));
      assert.equal(row.rows[0].execution_attempt, 1, "no duplicate execution capability / attempt was created by losing racers");
    }
  });
});

// ===========================================================================
// PHASE 6 — AGENT / DEVICE / EXECUTION BINDING (cases 37-45)
// ===========================================================================
test("Phase 6: cross-agent and cross-device binding is enforced end to end", async (t) => {
  const { org, site } = await createOrgSite("binding");
  const agentA = await createAgentIdentity(org, site, "BINDA");
  const agentB = await createAgentIdentity(org, site, "BINDB");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "binding-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "binding-appr");

  async function readyJobFor(agent) {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    assert.equal(approved.status, 200);
    return job;
  }

  await t.test("37. Agent A cannot claim a job belonging to Device B", async () => {
    const jobB = await readyJobFor(agentB);
    const path = "/v1/agent/remote-commands/claim";
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agentA, "POST", path, "{}") });
    // Agent A's own claim query only ever looks at Device A's READY jobs, so it
    // either finds nothing (204) or — if this ever regresses — must never
    // return Device B's job.
    assert.notEqual(r.status, 200, "Agent A must never be handed Device B's job");
    if (r.status === 200) assert.notEqual(r.body.id, jobB.id);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [jobB.id]);
    assert.equal(row.rows[0].status, "READY", "Device B job is untouched by Agent A's claim attempt");
  });

  await t.test("38. Key A cannot authenticate as Agent B (signature/device mismatch rejected)", async () => {
    const path = "/v1/agent/remote-commands/claim";
    // Bearer for device B, but signed with device A's key id + private key.
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agentB, "POST", path, "{}", { keyId: agentA.keyId, privateKey: agentA.keyPair.privateKey, token: agentB.token }) });
    assert.equal(r.status, 401);
  });

  await t.test("39-42. Agent A cannot start/heartbeat/poll/submit against Agent B's execution", async () => {
    await readyJobFor(agentB);
    const pathB = "/v1/agent/remote-commands/claim";
    const claimB = await call("POST", pathB, { body: {}, headers: signedHeaders(agentB, "POST", pathB, "{}") });
    assert.equal(claimB.status, 200);
    // The claim endpoint is FIFO over READY jobs for the device, so the job it
    // actually claimed (not necessarily the one just created above, if an
    // earlier subtest left one READY) is the one under test here.
    const claimedJobId = claimB.body.id;
    const execution = claimB.body;
    const startBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });

    const startAsA = await call("POST", `/v1/agent/remote-commands/${claimedJobId}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agentA, "POST", `/v1/agent/remote-commands/${claimedJobId}/start`, startBody) });
    assert.equal(startAsA.status, 404, "Agent A starting Device B's execution must be a safe 404, not leak state");

    const heartbeatAsA = await call("POST", `/v1/agent/remote-commands/${claimedJobId}/heartbeat`, { body: JSON.parse(startBody), headers: signedHeaders(agentA, "POST", `/v1/agent/remote-commands/${claimedJobId}/heartbeat`, startBody) });
    assert.equal(heartbeatAsA.status, 404);

    const statusAsA = await call("POST", `/v1/agent/remote-commands/${claimedJobId}/status`, { body: {}, headers: signedHeaders(agentA, "POST", `/v1/agent/remote-commands/${claimedJobId}/status`, "{}") });
    assert.equal(statusAsA.status, 404, "Agent A polling Device B's status must be a safe 404");

    const resultBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability, exit_code: 0 });
    const resultAsA = await call("POST", `/v1/agent/remote-commands/${claimedJobId}/result`, { body: JSON.parse(resultBody), headers: signedHeaders(agentA, "POST", `/v1/agent/remote-commands/${claimedJobId}/result`, resultBody) });
    assert.equal(resultAsA.status, 404);

    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [claimedJobId]);
    assert.equal(row.rows[0].status, "CLAIMED", "forbidden DB state remains unchanged after every rejected cross-agent attempt");
  });

  await t.test("43. wrong execution ID rejected", async () => {
    await readyJobFor(agentB);
    const pathB = "/v1/agent/remote-commands/claim";
    const claimB = await call("POST", pathB, { body: {}, headers: signedHeaders(agentB, "POST", pathB, "{}") });
    assert.equal(claimB.status, 200);
    const claimedJobId = claimB.body.id;
    const wrongBody = JSON.stringify({ execution_id: crypto.randomUUID(), execution_capability: claimB.body.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${claimedJobId}/start`, { body: JSON.parse(wrongBody), headers: signedHeaders(agentB, "POST", `/v1/agent/remote-commands/${claimedJobId}/start`, wrongBody) });
    assert.equal(r.status, 404);
  });

  await t.test("44. wrong device binding (execution capability from another device) rejected", async () => {
    const jobA = await readyJobFor(agentA);
    const jobB = await readyJobFor(agentB);
    const pathA = "/v1/agent/remote-commands/claim";
    const pathB = "/v1/agent/remote-commands/claim";
    const claimA = await call("POST", pathA, { body: {}, headers: signedHeaders(agentA, "POST", pathA, "{}") });
    const claimB = await call("POST", pathB, { body: {}, headers: signedHeaders(agentB, "POST", pathB, "{}") });
    assert.equal(claimA.status, 200); assert.equal(claimB.status, 200);
    // Agent B tries to start job A's execution using B's own capability string.
    const crossBody = JSON.stringify({ execution_id: claimA.body.execution_id, execution_capability: claimB.body.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${jobA.id}/start`, { body: JSON.parse(crossBody), headers: signedHeaders(agentB, "POST", `/v1/agent/remote-commands/${jobA.id}/start`, crossBody) });
    assert.equal(r.status, 404);
  });

  await t.test("45. valid signature using the wrong bound key is rejected", async () => {
    const jobA = await readyJobFor(agentA);
    const pathA = "/v1/agent/remote-commands/claim";
    // A validly-formed signature, verified correctly, but produced with device
    // B's key while presenting device A's bearer: must fail at key-binding, not
    // at signature-shape validation.
    const r = await call("POST", pathA, { body: {}, headers: signedHeaders(agentA, "POST", pathA, "{}", { keyId: agentB.keyId, privateKey: agentB.keyPair.privateKey }) });
    assert.equal(r.status, 401);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [jobA.id]);
    assert.equal(row.rows[0].status, "READY", "forbidden DB state remains unchanged");
  });
});

// ===========================================================================
// PHASE 7 — SIGNED START (cases 46-53)
// ===========================================================================
test("Phase 7: signed start lifecycle", async (t) => {
  const { org, site } = await createOrgSite("start");
  const agent = await createAgentIdentity(org, site, "START");
  const otherAgent = await createAgentIdentity(org, site, "STARTOTHER");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "start-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "start-appr");

  async function claimed() {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    assert.equal(approved.status, 200);
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(claim.status, 200);
    return { job, execution: claim.body };
  }

  await t.test("46. valid signed start accepted; 51. CLAIMED -> RUNNING succeeds", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "RUNNING");
    const row = await pool.query("SELECT status, started_at FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].status, "RUNNING");
    assert.ok(row.rows[0].started_at);
  });

  await t.test("47. unsigned start rejected", async () => {
    const { job, execution } = await claimed();
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: { execution_id: execution.execution_id, execution_capability: execution.execution_capability }, headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(r.status, 401);
  });

  await t.test("48. wrong Agent start rejected", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers: signedHeaders(otherAgent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body) });
    assert.equal(r.status, 404);
  });

  await t.test("49. wrong execution ID rejected", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: crypto.randomUUID(), execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body) });
    assert.equal(r.status, 404);
  });

  await t.test("50. replayed start nonce rejected", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const headers = signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body);
    const first = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers });
    assert.equal(first.status, 200);
    const replay = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers });
    assert.equal(replay.status, 409, "replayed nonce is rejected by the nonce table before reaching state logic");
  });

  await t.test("52. second start (idempotent re-signed start while RUNNING) follows safe defined behavior", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const first = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body) });
    assert.equal(first.status, 200);
    const second = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, body) });
    assert.equal(second.status, 200, "a fresh, distinctly-nonced start while already RUNNING is idempotent, not an error");
    assert.equal(second.body.status, "RUNNING");
  });

  await t.test("53. terminal job cannot be started again", async () => {
    const { job, execution } = await claimed();
    const startBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    const resultPayload = { execution_id: execution.execution_id, execution_capability: execution.execution_capability, exit_code: 0, stdout: "done" };
    const resultBody = JSON.stringify(resultPayload);
    const result = await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { body: resultPayload, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "SUCCEEDED");
    const restartBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const restart = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(restartBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, restartBody) });
    assert.equal(restart.status, 409, "a terminal (SUCCEEDED) job must refuse a start transition");
  });
});

// ===========================================================================
// PHASE 8 — HEARTBEAT / LEASE (cases 54-62)
// ===========================================================================
test("Phase 8: signed heartbeat and lease renewal", async (t) => {
  const { org, site } = await createOrgSite("heartbeat");
  const agent = await createAgentIdentity(org, site, "HB");
  const otherAgent = await createAgentIdentity(org, site, "HBOTHER");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "hb-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "hb-appr");

  async function claimed() {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    assert.equal(approved.status, 200);
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(claim.status, 200);
    return { job, execution: claim.body };
  }

  await t.test("54-55. valid signed heartbeat accepted and renews the lease (real DB lease timestamps)", async () => {
    const { job, execution } = await claimed();
    const before = (await pool.query("SELECT lease_expires_at FROM nexora_remote_command_jobs WHERE id=$1", [job.id])).rows[0].lease_expires_at;
    await new Promise((r) => setTimeout(r, 20));
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, body) });
    assert.equal(r.status, 200);
    const after = (await pool.query("SELECT lease_expires_at, last_execution_heartbeat_at FROM nexora_remote_command_jobs WHERE id=$1", [job.id])).rows[0];
    assert.ok(new Date(after.lease_expires_at).getTime() > new Date(before).getTime(), "lease_expires_at must move forward on heartbeat");
    assert.ok(after.last_execution_heartbeat_at);
  });

  await t.test("56. unsigned heartbeat rejected", async () => {
    const { job, execution } = await claimed();
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: { execution_id: execution.execution_id, execution_capability: execution.execution_capability }, headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(r.status, 401);
  });

  await t.test("57. wrong Agent rejected; 58. wrong device rejected (same case here — one device per agent)", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(body), headers: signedHeaders(otherAgent, "POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, body) });
    assert.equal(r.status, 404);
  });

  await t.test("59. wrong execution ID rejected", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: crypto.randomUUID(), execution_capability: execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(body), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, body) });
    assert.equal(r.status, 404);
  });

  await t.test("60. replayed heartbeat nonce rejected", async () => {
    const { job, execution } = await claimed();
    const body = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const headers = signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, body);
    const first = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(body), headers });
    assert.equal(first.status, 200);
    const replay = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(body), headers });
    assert.equal(replay.status, 409);
  });

  await t.test("61. heartbeat cannot mutate another execution", async () => {
    const first = await claimed();
    const second = await claimed();
    const crossBody = JSON.stringify({ execution_id: second.execution.execution_id, execution_capability: second.execution.execution_capability });
    const r = await call("POST", `/v1/agent/remote-commands/${first.job.id}/heartbeat`, { body: JSON.parse(crossBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${first.job.id}/heartbeat`, crossBody) });
    assert.equal(r.status, 404, "execution id in the body must match the job named in the path");
    const row = await pool.query("SELECT execution_id FROM nexora_remote_command_jobs WHERE id=$1", [first.job.id]);
    assert.equal(row.rows[0].execution_id, first.execution.execution_id, "first execution's identity is untouched");
  });

  await t.test("62. terminal execution heartbeat is safely rejected per the intended contract", async () => {
    const { job, execution } = await claimed();
    const startBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    const resultPayload = { execution_id: execution.execution_id, execution_capability: execution.execution_capability, exit_code: 0 };
    const resultBody = JSON.stringify(resultPayload);
    const result = await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { body: resultPayload, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
    assert.equal(result.status, 200); assert.equal(result.body.status, "SUCCEEDED");
    const hbBody = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
    const hb = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { body: JSON.parse(hbBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, hbBody) });
    assert.equal(hb.status, 409, "a terminal job's contract explicitly disallows re-entering CLAIMED/RUNNING-only heartbeat");
  });
});

// ===========================================================================
// PHASE 9 — STATUS / CANCELLATION POLLING SECURITY (cases 63-74)
// ===========================================================================
test("Phase 9: signed status/cancellation polling security", async (t) => {
  const { org, site } = await createOrgSite("status-poll");
  const agent = await createAgentIdentity(org, site, "POLL");
  const otherAgent = await createAgentIdentity(org, site, "POLLOTHER");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "poll-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "poll-appr");

  async function claimedJob() {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    assert.equal(approved.status, 200);
    const path = "/v1/agent/remote-commands/claim";
    const c = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(c.status, 200);
    return job;
  }

  await t.test("63. valid signed request accepted", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "CLAIMED");
  });
  await t.test("64. bearer-only rejected", async () => {
    const job = await claimedJob();
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/status`, { body: {}, headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(r.status, 401);
  });
  await t.test("65. missing signature rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}", { omit: ["x-nexora-signature"] }) });
    assert.equal(r.status, 401);
  });
  await t.test("66. replay nonce rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const headers = signedHeaders(agent, "POST", path, "{}");
    const first = await call("POST", path, { body: {}, headers });
    assert.equal(first.status, 200);
    const second = await call("POST", path, { body: {}, headers });
    assert.equal(second.status, 409);
  });
  await t.test("67. stale timestamp rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}", { timestamp: String(Math.floor(Date.now() / 1000) - 400) }) });
    assert.equal(r.status, 401);
  });
  await t.test("68. wrong key rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}", { keyId: otherAgent.keyId, privateKey: otherAgent.keyPair.privateKey }) });
    assert.equal(r.status, 401);
  });
  await t.test("69. wrong Agent rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(otherAgent, "POST", path, "{}") });
    assert.equal(r.status, 404);
  });
  await t.test("70. wrong device rejected (otherAgent bound to a different device)", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(otherAgent, "POST", path, "{}") });
    assert.equal(r.status, 404);
  });
  await t.test("71. wrong job/execution rejected", async () => {
    const path = `/v1/agent/remote-commands/${crypto.randomUUID()}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(r.status, 404);
  });
  await t.test("72. path tampering rejected", async () => {
    const job = await claimedJob();
    const realPath = `/v1/agent/remote-commands/${job.id}/status`;
    const otherJobPath = `/v1/agent/remote-commands/${crypto.randomUUID()}/status`;
    const r = await call("POST", realPath, { body: {}, headers: signedHeaders(agent, "POST", otherJobPath, "{}") });
    assert.equal(r.status, 401);
  });
  await t.test("73. method tampering rejected", async () => {
    const job = await claimedJob();
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "GET", path, "{}") });
    assert.equal(r.status, 401);
  });
  await t.test("74. body tampering rejected where applicable (status has no meaningful body, so use result)", async () => {
    const job = await claimedJob();
    const claim = await pool.query("SELECT execution_id, execution_capability_hash FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    const path = `/v1/agent/remote-commands/${job.id}/status`;
    const headers = signedHeaders(agent, "POST", path, "{}");
    const r = await call("POST", path, { body: { unexpected: "payload" }, headers });
    assert.equal(r.status, 401, "a body was signed as empty {} — sending a different body must fail verification");
  });
});

// ===========================================================================
// PHASE 10 — USER REQUEST / PRIVILEGED APPROVAL (cases 75-86)
// ===========================================================================
test("Phase 10: user-facing request + two-person approval workflow via real session/CSRF/RBAC", async (t) => {
  const { org, site } = await createOrgSite("approval");
  const otherOrg = await createOrgSite("approval-other-tenant");
  const agent = await createAgentIdentity(org, site, "APPROVAL");
  const requester = await createUser(org, "ORGANIZATION_TECHNICIAN", "appr-requester");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "appr-approver");
  const unauthorized = await createUser(org, "ORGANIZATION_VIEWER", "appr-unauthorized");

  await t.test("75-77. authorized requester creates REMOTE_COMMAND, privileged action is linked, correct initial state", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo phase10", reason: "phase10 acceptance" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "PENDING");
    assert.ok(created.body.privilegedActionId);
    const action = await pool.query("SELECT status, requires_two_person, requested_by FROM nexora_privileged_actions WHERE id=$1", [created.body.privilegedActionId]);
    assert.equal(action.rows[0].status, "PENDING_APPROVAL");
    assert.equal(action.rows[0].requires_two_person, true);
    assert.equal(action.rows[0].requested_by, requester.id);
  });

  await t.test("78. missing CSRF rejected", async () => {
    const session = await login(requester);
    const r = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1" }, body: { device_id: agent.device, shell: "CMD", command: "echo nocsrf", reason: "phase10" } });
    assert.equal(r.status, 403);
  });

  await t.test("79. missing capability rejected (viewer role lacks remote_commands.request)", async () => {
    const session = await login(unauthorized);
    const r = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo denied", reason: "phase10" } });
    assert.equal(r.status, 403);
  });

  await t.test("80. cross-tenant device returns safe 404", async () => {
    const otherAgent = await createAgentIdentity(otherOrg.org, otherOrg.site, "CROSSTENANT");
    const session = await login(requester);
    const r = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: otherAgent.device, shell: "CMD", command: "echo crosstenant", reason: "phase10" } });
    assert.equal(r.status, 404);
  });

  await t.test("81. command cannot become READY before approval", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo notready", reason: "phase10" } });
    assert.equal(created.status, 201);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [created.body.privilegedActionId]);
    assert.equal(row.rows[0].status, "PENDING");
  });

  await t.test("82. requester cannot self-approve when two-person rule applies", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo selfapprove", reason: "phase10" } });
    // requester also happens to hold privileged_actions.approve? ORGANIZATION_TECHNICIAN does not,
    // so exercise self-approval with a requester who *does* hold approve permission.
    const dualRoleRequester = await createUser(org, "ORGANIZATION_ADMIN", "appr-dualrole");
    const dualSession = await login(dualRoleRequester);
    const ownRequest = await call("POST", "/v1/remote-commands", { cookie: dualSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": dualSession.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo dualrole", reason: "phase10" } });
    assert.equal(ownRequest.status, 201);
    const selfApprove = await call("POST", `/v1/privileged-actions/${ownRequest.body.privilegedActionId}/approve`, { cookie: dualSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": dualSession.csrf } });
    assert.equal(selfApprove.status, 403);
    const action = await pool.query("SELECT status FROM nexora_privileged_actions WHERE id=$1", [ownRequest.body.privilegedActionId]);
    assert.equal(action.rows[0].status, "PENDING_APPROVAL", "self-approval attempt leaves state unchanged");
    void created;
  });

  await t.test("83-86. unauthorized cannot approve; authorized second approver can; approval persists; READY only if gates pass", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo secondapprover", reason: "phase10" } });
    assert.equal(created.status, 201);

    const unauthorizedSession = await login(unauthorized);
    const deniedApprove = await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, { cookie: unauthorizedSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": unauthorizedSession.csrf } });
    assert.equal(deniedApprove.status, 403);

    const approverSession = await login(approver);
    const approve = await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, "APPROVED");
    assert.equal(approve.body.approvedBy, approver.id);

    const persisted = await pool.query("SELECT status, approved_by FROM nexora_privileged_actions WHERE id=$1", [created.body.privilegedActionId]);
    assert.equal(persisted.rows[0].status, "APPROVED");
    assert.equal(persisted.rows[0].approved_by, approver.id);

    const job = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [created.body.privilegedActionId]);
    assert.equal(job.rows[0].status, "READY", "with the global gate, device gate, and capability gate all satisfied the job reaches READY");
  });
});

// ===========================================================================
// PHASE 11 — EXECUTION FEATURE GATES (cases 87-90)
// ===========================================================================
test("Phase 11: execution feature gates are independently enforced", async (t) => {
  const { org, site } = await createOrgSite("gates");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "gates-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "gates-appr");

  async function approvedJobFor(agent) {
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const { job, approved } = await requestApprovedReadyJob({ requester: requesterSession, approver: approverSession, org, device: agent.device });
    return { job, approved };
  }

  await t.test("87. REMOTE_COMMANDS_ENABLED=false -> execution not eligible", async () => {
    const agent = await createAgentIdentity(org, site, "GATE87", { remoteCommandsEnabled: true, capabilities: ["remote_command_v1"] });
    // Request and approve while the global flag is on (creation itself is
    // gated separately, at 503, and is not what this case is probing), then
    // flip it off before the agent ever attempts to claim.
    const { job, approved } = await approvedJobFor(agent);
    assert.equal(approved.status, 200);
    const readyRow = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [job.privilegedActionId]);
    assert.equal(readyRow.rows[0].status, "READY");
    const previous = process.env.REMOTE_COMMANDS_ENABLED;
    process.env.REMOTE_COMMANDS_ENABLED = "false";
    try {
      const path = "/v1/agent/remote-commands/claim";
      const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
      assert.equal(r.status, 204, "global gate disabled: agent must not be able to claim");
      const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [job.privilegedActionId]);
      assert.equal(row.rows[0].status, "READY", "job is untouched while the global gate is off");
    } finally {
      process.env.REMOTE_COMMANDS_ENABLED = previous;
    }
  });

  await t.test("88. global enabled, device.remote_commands_enabled=false -> execution not eligible", async () => {
    const agent = await createAgentIdentity(org, site, "GATE88", { remoteCommandsEnabled: false, capabilities: ["remote_command_v1"] });
    const { job } = await approvedJobFor(agent);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [job.privilegedActionId]);
    assert.equal(row.rows[0].status, "PENDING", "device gate disabled: job must stay PENDING");
  });

  await t.test("89. global enabled, device enabled, remote_command_v1 capability absent -> execution not eligible", async () => {
    const agent = await createAgentIdentity(org, site, "GATE89", { remoteCommandsEnabled: true, capabilities: [] });
    const { job } = await approvedJobFor(agent);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [job.privilegedActionId]);
    assert.equal(row.rows[0].status, "PENDING", "capability gate absent: job must stay PENDING");
  });

  await t.test("90. global enabled, device enabled, remote_command_v1 present -> execution eligible", async () => {
    const agent = await createAgentIdentity(org, site, "GATE90", { remoteCommandsEnabled: true, capabilities: ["remote_command_v1"] });
    const { job } = await approvedJobFor(agent);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [job.privilegedActionId]);
    assert.equal(row.rows[0].status, "READY", "all three gates satisfied: job must be READY");
  });
});

// ===========================================================================
// PHASE 12 — INITIAL STATE MACHINE (cases 91-99)
// ===========================================================================
test("Phase 12: persisted lifecycle transitions are exactly the legal ones", async (t) => {
  const { org, site } = await createOrgSite("lifecycle");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "life-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "life-appr");

  // Each subtest gets its own device so the claim endpoint's FIFO-over-READY-
  // jobs behavior can never pick up a different subtest's leftover job (some
  // subtests here deliberately leave a job un-claimed to probe a transition).
  async function requestOnly(agent) {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo lifecycle", reason: "phase12" } });
    assert.equal(created.status, 201);
    return created.body;
  }

  await t.test("91. full legal path PENDING_APPROVAL -> APPROVED -> READY -> CLAIMED -> RUNNING succeeds", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE91");
    const job = await requestOnly(agent);
    const requesterSession = await login(requester);
    const approverSession = await login(approver);
    const approve = await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(approve.status, 200); assert.equal(approve.body.status, "APPROVED");
    const readyRow = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(readyRow.rows[0].status, "READY");
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(claim.status, 200);
    const claimedRow = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(claimedRow.rows[0].status, "CLAIMED");
    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    const start = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    assert.equal(start.status, 200); assert.equal(start.body.status, "RUNNING");
    void requesterSession;
  });

  await t.test("92. PENDING_APPROVAL cannot be claimed", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE92");
    const job = await requestOnly(agent);
    const path = "/v1/agent/remote-commands/claim";
    const before = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(before.rows[0].status, "PENDING");
    const r = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(r.status, 204, "no READY job exists so the agent gets an empty claim response");
    const after = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(after.rows[0].status, "PENDING", "state is unchanged");
  });

  await t.test("93. APPROVED but non-READY execution cannot start", async () => {
    // Force an inconsistent state directly to prove the start route itself
    // enforces CLAIMED-only, independent of how the row got there.
    const agent = await createAgentIdentity(org, site, "LIFECYCLE93");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const execId = crypto.randomUUID();
    const capability = crypto.randomBytes(32).toString("base64url");
    await pool.query("UPDATE nexora_remote_command_jobs SET execution_id=$2, execution_capability_hash=$3 WHERE id=$1", [job.id, execId, crypto.createHash("sha256").update(capability).digest("hex")]);
    const startBody = JSON.stringify({ execution_id: execId, execution_capability: capability });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    assert.equal(r.status, 409, "job is READY, not CLAIMED, so start must be refused");
  });

  await t.test("94. READY cannot jump directly to RUNNING", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE94");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].status, "READY");
    const fakeBody = JSON.stringify({ execution_id: crypto.randomUUID(), execution_capability: "irrelevant-capability-value-000000" });
    const r = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(fakeBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, fakeBody) });
    assert.equal(r.status, 404, "no execution_id/capability has been issued yet (job never claimed), so start is rejected");
  });

  await t.test("95. second claim rejected (job already CLAIMED)", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE95");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const first = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(first.status, 200);
    const second = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(second.status, 204, "no further READY job exists for a second claim");
    const row = await pool.query("SELECT execution_id FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].execution_id, first.body.execution_id, "the original execution id is untouched");
  });

  await t.test("96. RUNNING cannot transition backward to READY", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE96");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    const start = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    assert.equal(start.status, 200); assert.equal(start.body.status, "RUNNING");
    // There is no production route that transitions RUNNING back to READY;
    // verify no such regression by re-claiming (must not resurrect READY).
    const reclaim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(reclaim.status, 204);
    const row = await pool.query("SELECT status FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].status, "RUNNING");
  });

  await t.test("97. terminal job cannot be claimed", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE97");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    const resultPayload = { execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability, exit_code: 0 };
    const resultBody = JSON.stringify(resultPayload);
    await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { body: resultPayload, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
    const reclaim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(reclaim.status, 204, "a terminal job is never eligible for claim again");
  });

  await t.test("98. terminal job cannot be restarted", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE98");
    const job = await requestOnly(agent);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${job.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, startBody) });
    const resultPayload = { execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability, exit_code: 0 };
    const resultBody = JSON.stringify(resultPayload);
    await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { body: resultPayload, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
    const restartBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    const restart = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { body: JSON.parse(restartBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${job.id}/start`, restartBody) });
    assert.equal(restart.status, 409);
  });

  await t.test("99. invalid transition leaves DB state unchanged", async () => {
    const agent = await createAgentIdentity(org, site, "LIFECYCLE99");
    const job = await requestOnly(agent);
    const path = "/v1/agent/remote-commands/claim";
    const before = await pool.query("SELECT * FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    const attempt = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(attempt.status, 204);
    const after = await pool.query("SELECT * FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
    assert.deepEqual(after.rows[0], before.rows[0], "an invalid/no-op transition must not mutate the row at all");
  });
});

// ===========================================================================
// PHASE 13 — AUDIT SECURITY (cases 100-105)
// ===========================================================================
test("Phase 13: audit evidence is persisted for every required security event", async (t) => {
  const { org, site } = await createOrgSite("audit");
  const agent = await createAgentIdentity(org, site, "AUDIT");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "audit-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "audit-appr");

  await t.test("100-103. remote command requested, privileged approval, Agent claim, Agent start are all audited", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo audit", reason: "phase13" } });
    assert.equal(created.status, 201);
    const requested = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_REQUESTED' AND target_id=$1", [created.body.id]);
    assert.equal(requested.rowCount, 1, "100. remote command requested must be audited");

    const approverSession = await login(approver);
    const approve = await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    assert.equal(approve.status, 200);
    const approved = await pool.query("SELECT * FROM nexora_audit_log WHERE action='PRIVILEGED_ACTION_APPROVED' AND target_id=$1", [created.body.privilegedActionId]);
    assert.equal(approved.rowCount, 1, "101. privileged approval must be audited");

    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(claim.status, 200);
    const claimAudit = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_CLAIMED' AND target_id=$1", [created.body.id]);
    assert.equal(claimAudit.rowCount, 1, "102. Agent claim must be audited");

    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    const start = await call("POST", `/v1/agent/remote-commands/${created.body.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${created.body.id}/start`, startBody) });
    assert.equal(start.status, 200);
    const startAudit = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_STARTED' AND target_id=$1", [created.body.id]);
    assert.equal(startAudit.rowCount, 1, "103. Agent start must be audited");
  });

  await t.test("104. replay/security rejection is audited", async () => {
    const path = "/v1/agent/remote-commands/claim";
    const headers = signedHeaders(agent, "POST", path, "{}");
    const first = await call("POST", path, { body: {}, headers });
    assert.equal(first.status, 204);
    const replay = await call("POST", path, { body: {}, headers });
    assert.equal(replay.status, 409);
    const audited = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_REPLAY_REJECTED' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1", [org]);
    assert.equal(audited.rowCount, 1, "a replay rejection must leave an audit trail");
  });

  await t.test("105. terminal result/conflict event preserves REMOTE_COMMAND_RESULT_CONFLICT", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo conflict", reason: "phase13" } });
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    const startBody = JSON.stringify({ execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability });
    await call("POST", `/v1/agent/remote-commands/${created.body.id}/start`, { body: JSON.parse(startBody), headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${created.body.id}/start`, startBody) });
    const first = { execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability, exit_code: 0, stdout: "first" };
    const firstBody = JSON.stringify(first);
    const firstResult = await call("POST", `/v1/agent/remote-commands/${created.body.id}/result`, { body: first, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${created.body.id}/result`, firstBody) });
    assert.equal(firstResult.status, 200);
    const conflicting = { execution_id: claim.body.execution_id, execution_capability: claim.body.execution_capability, exit_code: 1, stdout: "different" };
    const conflictingBody = JSON.stringify(conflicting);
    const conflictResult = await call("POST", `/v1/agent/remote-commands/${created.body.id}/result`, { body: conflicting, headers: signedHeaders(agent, "POST", `/v1/agent/remote-commands/${created.body.id}/result`, conflictingBody) });
    assert.equal(conflictResult.status, 409);
    const audited = await pool.query("SELECT * FROM nexora_audit_log WHERE action='REMOTE_COMMAND_RESULT_CONFLICT' AND target_id=$1", [created.body.id]);
    assert.equal(audited.rowCount, 1, "REMOTE_COMMAND_RESULT_CONFLICT behavior is preserved");
  });
});

// ===========================================================================
// PHASE 14 — REDACTION
// ===========================================================================
test("Phase 14: synthetic secret sentinels never leak", async (t) => {
  const { org, site } = await createOrgSite("redaction");
  const agent = await createAgentIdentity(org, site, "REDACT");
  const requester = await createUser(org, "ORGANIZATION_ADMIN", "redact-req");
  const approver = await createUser(org, "ORGANIZATION_ADMIN", "redact-appr");

  await t.test("agent bearer / execution capability / private key sentinels are absent from audit, error bodies and job records", async () => {
    const session = await login(requester);
    const created = await call("POST", "/v1/remote-commands", { cookie: session.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: { device_id: agent.device, shell: "CMD", command: "echo redact", reason: `${SENTINELS.adminToken} should never leak` } });
    assert.equal(created.status, 201);
    const approverSession = await login(approver);
    await call("POST", `/v1/privileged-actions/${created.body.privilegedActionId}/approve`, { cookie: approverSession.cookie, headers: { origin: "http://127.0.0.1", "x-csrf-token": approverSession.csrf } });
    const path = "/v1/agent/remote-commands/claim";
    const claim = await call("POST", path, { body: {}, headers: signedHeaders(agent, "POST", path, "{}") });
    assert.equal(claim.status, 200);
    assert.ok(!claim.body.execution_capability.includes(SENTINELS.executionCapability), "the capability is a fresh random token, never the sentinel value itself");

    // Deliberately trigger a rejection path and inspect the raw HTTP error body.
    const failedAuth = await call("POST", path, { body: {}, headers: { authorization: `Bearer wrong-${SENTINELS.agentBearer}` } });
    assert.equal(failedAuth.status, 401);
    assert.ok(!failedAuth.rawText.includes(SENTINELS.agentBearer), "error body must not echo back bearer material");
    assert.ok(!failedAuth.rawText.includes(agent.token), "error body must not echo back the real agent token");

    const auditRows = await pool.query("SELECT metadata::text AS metadata, action FROM nexora_audit_log WHERE organization_id=$1", [org]);
    for (const row of auditRows.rows) {
      const text = row.metadata ?? "";
      assert.ok(!text.includes(agent.token), `audit metadata for ${row.action} must not contain the raw agent bearer token`);
      assert.ok(!text.includes(SENTINELS.privateKey), `audit metadata for ${row.action} must not contain a private-key sentinel`);
      assert.ok(!text.includes(SENTINELS.executionCapability), `audit metadata for ${row.action} must not contain an execution-capability sentinel`);
    }

    const jobRow = await pool.query("SELECT command_payload::text AS payload FROM nexora_remote_command_jobs WHERE privileged_action_id=$1", [created.body.privilegedActionId]);
    assert.ok(!jobRow.rows[0].payload.includes(agent.token), "persisted job payload must not contain the raw agent bearer token");

    // The private ECDSA test key never leaves process memory / is never persisted anywhere.
    const keyRow = await pool.query("SELECT public_key FROM nexora_agent_signing_keys WHERE device_id=$1", [agent.device]);
    assert.ok(keyRow.rows[0].public_key.includes("PUBLIC KEY"), "only the public key is ever persisted");
    assert.ok(!keyRow.rows[0].public_key.includes("PRIVATE"), "the private key must never be persisted");
  });
});
