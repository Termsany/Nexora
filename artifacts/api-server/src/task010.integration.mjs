import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import pg from "pg";
import { createApp } from "./app.ts";
import { hashPassword } from "./auth/password.ts";
import { canonicalAgentRequest } from "./security/agent-signing.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ids = { org: crypto.randomUUID(), site: crypto.randomUUID(), device: crypto.randomUUID(), user: crypto.randomUUID(), key: crypto.randomUUID() };
const agentToken = `synthetic-agent-${crypto.randomUUID()}`;
const password = "task010-smoke-password";
let server;
let baseUrl;
let sessionCookie;
let csrf;
let keyPair;

function assertSyntheticDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "postgres"].includes(url.hostname), "integration DB must be disposable");
  assert.match(url.pathname, /test|integration|task010/);
}

async function call(method, path, { body, headers = {}, cookies = true } = {}) {
  const h = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  if (cookies && sessionCookie) h.cookie = sessionCookie;
  const response = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

function signedHeaders(method, path, body = "", overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? crypto.randomBytes(16).toString("hex");
  const canonical = canonicalAgentRequest(method, path, Buffer.from(body), timestamp, nonce, "TASK010-AGENT", ids.key);
  const signature = crypto.sign("sha256", Buffer.from(canonical), { key: keyPair.privateKey, dsaEncoding: "der" }).toString("base64");
  return { authorization: `Bearer ${agentToken}`, "x-nexora-signature-version": "nexora-agent-sign-v1", "x-nexora-key-id": ids.key, "x-nexora-timestamp": timestamp, "x-nexora-nonce": nonce, "x-nexora-signature": overrides.signature ?? signature };
}

before(async () => {
  assertSyntheticDatabase();
  keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const passwordHash = await hashPassword(password);
  await pool.query("INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,$2,$3)", [ids.org, "Task010 Smoke", `task010-${ids.org}`]);
  await pool.query("INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,$3)", [ids.site, ids.org, "Smoke Site"]);
  await pool.query("INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id,remote_commands_enabled,capabilities) VALUES ($1,'TASK010-AGENT',$2,'TASK010-SMOKE',$3,$4,true,'[\"remote_command_v1\"]')", [ids.device, crypto.randomUUID(), ids.org, ids.site]);
  await pool.query("INSERT INTO nexora_agent_credentials(device_id,token_hash) VALUES ($1,$2)", [ids.device, crypto.createHash("sha256").update(agentToken).digest("hex")]);
  await pool.query("INSERT INTO nexora_agent_signing_keys(id,device_id,algorithm,public_key,key_fingerprint,protocol_version) VALUES ($1,$2,'ECDSA_P256_SHA256',$3,$4,'remote_command_v1')", [ids.key, ids.device, publicKey, crypto.createHash("sha256").update(publicKey).digest("hex")]);
  await pool.query("INSERT INTO nexora_users(id,email,name,password_hash,scope,platform_role) VALUES ($1,$2,'Task010 User',$3,'ORGANIZATION',NULL)", [ids.user, `task010-${ids.user}@test.invalid`, passwordHash]);
  await pool.query("INSERT INTO nexora_organization_memberships(user_id,organization_id,role) VALUES ($1,$2,'ORGANIZATION_ADMIN')", [ids.user, ids.org]);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.query("DELETE FROM nexora_remote_command_jobs WHERE device_id=$1", [ids.device]);
  await pool.query("DELETE FROM nexora_privileged_actions WHERE device_id=$1", [ids.device]);
  await pool.query("DELETE FROM nexora_users WHERE id=$1", [ids.user]);
  await pool.query("DELETE FROM nexora_devices WHERE id=$1", [ids.device]);
  await pool.query("DELETE FROM nexora_sites WHERE id=$1", [ids.site]);
  await pool.query("DELETE FROM nexora_organizations WHERE id=$1", [ids.org]);
  await pool.end();
});

test("Task010 smoke: health endpoint uses the real Express app", async () => {
  const response = await call("GET", "/healthz", { cookies: false });
  assert.equal(response.status, 200); assert.deepEqual(response.body, { status: "ok" });
});

test("Task010 smoke: real login establishes session and CSRF", async () => {
  const response = await call("POST", "/v1/auth/login", { cookies: false, body: { email: `task010-${ids.user}@test.invalid`, password } });
  assert.equal(response.status, 200);
  const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie().join(";") : (response.headers.get("set-cookie") ?? "");
  sessionCookie = `${/nexora_session=([^;]+)/.exec(setCookie)?.[0] ?? ""}; nexora_csrf=${response.body.csrf_token}`;
  csrf = response.body.csrf_token;
  assert.ok(sessionCookie); assert.ok(csrf);
});

test("Task010 smoke: synthetic tenant and device are readable through protected API", async () => {
  const response = await call("GET", `/v1/devices/${ids.device}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.id, ids.device);
  assert.equal(response.body.organization_id, ids.org);
});

test("Task010 smoke: CSRF protects real browser mutations", async () => {
  const denied = await call("POST", "/v1/remote-commands", { body: { device_id: ids.device, shell: "CMD", command: "echo smoke", reason: "smoke" }, headers: { origin: "http://127.0.0.1" } });
  assert.equal(denied.status, 403);
  const previous = process.env.REMOTE_COMMANDS_ENABLED; process.env.REMOTE_COMMANDS_ENABLED = "false";
  const allowed = await call("POST", "/v1/remote-commands", { body: { device_id: ids.device, shell: "CMD", command: "echo smoke", reason: "smoke" }, headers: { origin: "http://127.0.0.1", "x-csrf-token": csrf } });
  process.env.REMOTE_COMMANDS_ENABLED = previous;
  assert.equal(allowed.status, 503, `feature gate should block while disabled: ${JSON.stringify(allowed.body)}`);
});

test("Task010 smoke: Agent bearer reaches the real signing-key middleware", async () => {
  const body = "{}";
  const response = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", body) });
  assert.equal(response.status, 204);
});

test("Task010 smoke: Agent signing-key registration uses the real bearer binding", async () => {
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const response = await call("POST", "/v1/agent/signing-key", { cookies: false, body: { algorithm: "ECDSA_P256_SHA256", public_key: publicKey, protocol_version: "remote_command_v1" }, headers: { authorization: `Bearer ${agentToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.body.key_id, ids.key);
});

test("Task010 smoke: bearer-only Agent request is rejected", async () => {
  const response = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: { authorization: `Bearer ${agentToken}` } });
  assert.equal(response.status, 401);
});

test("Task010 smoke: tampered body and stale signature are rejected", async () => {
  const headers = signedHeaders("POST", "/v1/agent/remote-commands/claim", "{}");
  const tampered = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: { tampered: true }, headers });
  assert.equal(tampered.status, 401);
  const stale = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", "{}", { timestamp: String(Math.floor(Date.now() / 1000) - 301) }) });
  assert.equal(stale.status, 401);
});

test("Task010 smoke: nonce replay is rejected by the database", async () => {
  const headers = signedHeaders("POST", "/v1/agent/remote-commands/claim", "{}");
  const first = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers });
  const second = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers });
  assert.equal(first.status, 204); assert.equal(second.status, 409);
  const row = await pool.query("SELECT 1 FROM nexora_agent_request_nonces WHERE device_id=$1 LIMIT 1", [ids.device]);
  assert.equal(row.rowCount, 1);
});

test("Task010 smoke: wrong key id and malformed signatures are rejected", async () => {
  const wrong = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", "{}", { nonce: crypto.randomBytes(16).toString("hex") , signature: "bad" }) });
  assert.equal(wrong.status, 401);
  const missing = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: { ...signedHeaders("POST", "/v1/agent/remote-commands/claim", "{}"), "x-nexora-key-id": crypto.randomUUID() } });
  assert.equal(missing.status, 401);
});

async function createReadyJob() {
  const actionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const expires = new Date(Date.now() + 900_000);
  await pool.query("INSERT INTO nexora_privileged_actions(id,organization_id,device_id,action_type,status,requested_by,approved_by,approved_at,expires_at,request_reason,safe_parameters) VALUES ($1,$2,$3,'REMOTE_COMMAND','APPROVED',$4,$4,now(),$5,'Task010 integration','{}')", [actionId, ids.org, ids.device, ids.user, expires]);
  await pool.query("INSERT INTO nexora_remote_command_jobs(id,organization_id,device_id,privileged_action_id,status,shell_type,command_payload,timeout_seconds,requested_by_user_id,approved_by_user_id,expires_at) VALUES ($1,$2,$3,$4,'READY','CMD',$5,60,$6,$6,$7)", [jobId, ids.org, ids.device, actionId, JSON.stringify({ shell: "CMD", command: "echo task010" }), ids.user, expires]);
  return { id: jobId, actionId };
}

test("Task010 acceptance: concurrent signed claims have one winner", async () => {
  const job = await createReadyJob();
  const responses = await Promise.all(Array.from({ length: 5 }, () => {
    const body = "{}";
    return call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", body) });
  }));
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => r.status === 204).length, 4);
  const row = await pool.query("SELECT status,execution_id,execution_capability_hash,execution_attempt FROM nexora_remote_command_jobs WHERE id=$1", [job.id]);
  assert.equal(row.rows[0].status, "CLAIMED");
  assert.ok(row.rows[0].execution_id); assert.ok(row.rows[0].execution_capability_hash); assert.equal(row.rows[0].execution_attempt, 1);
});

test("Task010 acceptance: signed start and heartbeat renew the execution lease", async () => {
  const job = await createReadyJob();
  const claimBody = "{}";
  const claim = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", claimBody) });
  assert.equal(claim.status, 200);
  const execution = claim.body;
  const start = JSON.stringify({ execution_id: execution.execution_id, execution_capability: execution.execution_capability });
  const started = await call("POST", `/v1/agent/remote-commands/${job.id}/start`, { cookies: false, body: JSON.parse(start), headers: signedHeaders("POST", `/v1/agent/remote-commands/${job.id}/start`, start) });
  assert.equal(started.status, 200); assert.equal(started.body.status, "RUNNING");
  const beforeLease = new Date(started.body.lease_expires_at ?? started.body.leaseExpiresAt).getTime();
  const heartbeat = await call("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, { cookies: false, body: JSON.parse(start), headers: signedHeaders("POST", `/v1/agent/remote-commands/${job.id}/heartbeat`, start) });
  assert.equal(heartbeat.status, 200); assert.ok(new Date(heartbeat.body.lease_expires_at ?? heartbeat.body.leaseExpiresAt).getTime() >= beforeLease);
});

test("Task010 acceptance: signed status polling and terminal result idempotency are enforced", async () => {
  const job = await createReadyJob();
  const claimBody = "{}";
  const claim = await call("POST", "/v1/agent/remote-commands/claim", { cookies: false, body: {}, headers: signedHeaders("POST", "/v1/agent/remote-commands/claim", claimBody) });
  const execution = claim.body;
  const status = await call("POST", `/v1/agent/remote-commands/${job.id}/status`, { cookies: false, body: {}, headers: signedHeaders("POST", `/v1/agent/remote-commands/${job.id}/status`, "{}") });
  assert.equal(status.status, 200); assert.equal(status.body.status, "CLAIMED");
  const result = { execution_id: execution.execution_id, execution_capability: execution.execution_capability, exit_code: 0, stdout: "ok", stderr: "", stdout_truncated: false, stderr_truncated: false };
  const resultBody = JSON.stringify(result);
  const first = await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { cookies: false, body: result, headers: signedHeaders("POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
  assert.equal(first.status, 200); assert.equal(first.body.status, "SUCCEEDED");
  const retry = await call("POST", `/v1/agent/remote-commands/${job.id}/result`, { cookies: false, body: result, headers: signedHeaders("POST", `/v1/agent/remote-commands/${job.id}/result`, resultBody) });
  assert.equal(retry.status, 200, "an identical terminal result with a fresh signed request is idempotent");
});
