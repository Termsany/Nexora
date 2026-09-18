import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import { db, devicesTable, organizationsTable, remoteDesktopSessionsTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  authorizeSession, claimForAgent, closeSession, createSession, expireStaleSessions,
  getSession, hashToken, isExpired, markActive, markAgentConnected, tokenMatches,
} from "./sessions.ts";

/**
 * Session lifecycle against a real PostgreSQL. The properties under test are
 * the ones the security model depends on: one live session per device, token
 * scoping, and terminal transitions that cannot be undone.
 */

const suffix = crypto.randomBytes(4).toString("hex");
let orgId; let userId; let deviceA; let deviceB;
const extraUserIds = [];

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
  assert.match(url.pathname, /test|integration|task010/);
  [{ id: orgId }] = await db.insert(organizationsTable).values({ name: `RD Test ${suffix}`, slug: `rd-test-${suffix}`, status: "ACTIVE" }).returning({ id: organizationsTable.id });
  [{ id: userId }] = await db.insert(usersTable).values({ email: `rd-${suffix}@test.invalid`, name: "RD Tester", passwordHash: "x", scope: "PLATFORM", platformRole: "PLATFORM_SUPER_ADMIN", status: "ACTIVE" }).returning({ id: usersTable.id });
  const devices = await db.insert(devicesTable).values([
    { organizationId: orgId, hostname: `RD-A-${suffix}`, agentId: `RD-A-${suffix}`, deviceUuid: crypto.randomUUID(), status: "ONLINE", remoteDesktopEnabled: true, capabilities: ["remote_desktop_v1"] },
    { organizationId: orgId, hostname: `RD-B-${suffix}`, agentId: `RD-B-${suffix}`, deviceUuid: crypto.randomUUID(), status: "ONLINE", remoteDesktopEnabled: true, capabilities: ["remote_desktop_v1"] },
  ]).returning({ id: devicesTable.id });
  deviceA = devices[0].id; deviceB = devices[1].id;
});

after(async () => {
  await db.delete(remoteDesktopSessionsTable).where(eq(remoteDesktopSessionsTable.organizationId, orgId));
  await db.execute(sql`delete from nexora_privileged_actions where organization_id = ${orgId}`);
  await db.delete(devicesTable).where(eq(devicesTable.organizationId, orgId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  for (const id of extraUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

const open = (deviceId) => createSession({ organizationId: orgId, siteId: null, deviceId, userId, reason: "integration test" });

test("direct support route enforces capability, scope, readiness and command isolation", async t => {
  const password = crypto.randomBytes(24).toString("hex");
  await db.update(usersTable).set({ passwordHash: await hashPassword(password) }).where(eq(usersTable.id, userId));
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const extraUsers = [];
  async function identity(role, member = true) {
    const id = crypto.randomUUID(); extraUsers.push(id); extraUserIds.push(id);
    await db.insert(usersTable).values({ id, email: `${id}@test.invalid`, name: "Synthetic support", passwordHash: await hashPassword(password), scope: "ORGANIZATION", status: "ACTIVE" });
    if (member) await db.execute(sql`insert into nexora_organization_memberships(user_id,organization_id,role) values (${id},${orgId},${role})`);
    return { id, email: `${id}@test.invalid` };
  }
  async function login(email) {
    const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { cookie, "x-csrf-token": body.csrf_token, origin: "http://127.0.0.1", "content-type": "application/json" };
  }
  async function post(headers, path = "/v1/remote-desktop/sessions", body = { device_id: deviceA, reason: "Local direct support test" }) {
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  try {
    const owner = await login(`rd-${suffix}@test.invalid`);
    const supportIdentity = await identity("ORGANIZATION_ADMIN");
    const support = await login(supportIdentity.email);
    const ordinary = await login((await identity("ORGANIZATION_VIEWER")).email);
    // Give an admin a different real tenant scope, not just no membership.
    const otherOrg = crypto.randomUUID();
    await db.execute(sql`insert into nexora_organizations(id,name,slug) values (${otherOrg},'Other test tenant',${otherOrg})`);
    const outsiderIdentity = await identity("ORGANIZATION_ADMIN", false);
    await db.execute(sql`insert into nexora_organization_memberships(user_id,organization_id,role) values (${outsiderIdentity.id},${otherOrg},'ORGANIZATION_ADMIN')`);
    const outsider = await login(outsiderIdentity.email);
    await t.test("Owner and scoped Support Admin need no second approval", async () => {
      for (const headers of [owner, support]) {
        const created = await post(headers); assert.equal(created.status, 201);
        assert.equal(created.body.session.status, "AUTHORIZED");
        const result = await db.execute(sql`select requires_two_person from nexora_privileged_actions where id=${created.body.privileged_action_id}`);
        assert.equal(result.rows[0].requires_two_person, false);
        const stored = await getSession(created.body.session.id);
        assert.ok(tokenMatches(created.body.viewer_token, stored.viewerTokenHash));
        await closeSession(stored.id, "CLOSED", "test_cleanup");
      }
    });
    await t.test("ordinary user denied with audit", async () => {
      assert.equal((await post(ordinary)).status, 403);
      const audit = await db.execute(sql`select count(*)::int as n from nexora_audit_log where action='REMOTE_DESKTOP_REQUESTED' and result='DENIED' and metadata->>'reason'='permission_denied'`);
      assert.ok(audit.rows[0].n > 0);
    });
    await t.test("cross-tenant support denied", async () => assert.equal((await post(outsider)).status, 404));
    await t.test("unauthenticated and missing CSRF denied", async () => {
      assert.ok([401,403].includes((await post({ "content-type": "application/json" })).status));
      const { 'x-csrf-token': omitted, ...withoutCsrf } = owner;
      assert.equal((await post(withoutCsrf)).status, 403);
    });
    for (const [name, fields, code] of [
      ["device disabled", { remoteDesktopEnabled: false }, "device_disabled"],
      ["Agent incapable", { capabilities: [] }, "agent_incapable"],
      ["offline", { status: "OFFLINE" }, "device_offline"],
    ]) await t.test(name, async () => {
      await db.update(devicesTable).set(fields).where(eq(devicesTable.id, deviceA));
      try { const response = await post(owner); assert.equal(response.status, 409); assert.equal(response.body.code, code); }
      finally { await db.update(devicesTable).set({ remoteDesktopEnabled: true, capabilities: ["remote_desktop_v1"], status: "ONLINE" }).where(eq(devicesTable.id, deviceA)); }
    });
    await t.test("live session rejects a concurrent request", async () => {
      const created = await post(owner); assert.equal(created.status, 201);
      const busy = await post(support); assert.equal(busy.status, 409); assert.equal(busy.body.code, "device_busy");
      await closeSession(created.body.session.id, "CLOSED", "cleanup");
    });
    await t.test("Remote Command still requires two people and rejects requester approval", async () => {
      const created = await post(owner, "/v1/remote-commands", { device_id: deviceA, shell: "CMD", command: "echo synthetic", reason: "Local regression" });
      assert.equal(created.status, 201);
      const result = await db.execute(sql`select requires_two_person from nexora_privileged_actions where id=${created.body.privileged_action_id}`);
      assert.equal(result.rows[0].requires_two_person, true);
      assert.equal((await post(owner, `/v1/privileged-actions/${created.body.privileged_action_id}/approve`, {})).status, 403);
      await db.execute(sql`delete from nexora_remote_command_jobs where privileged_action_id=${created.body.privileged_action_id}`);
      await db.execute(sql`delete from nexora_privileged_actions where id=${created.body.privileged_action_id}`);
    });
    await db.execute(sql`delete from nexora_organization_memberships where organization_id=${otherOrg}`);
    await db.execute(sql`delete from nexora_organizations where id=${otherOrg}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Session/action fixtures belong to the outer suite's cleanup. Remove extra
    // accounts there too so audit/action foreign keys remain valid until then.
    for (const id of extraUsers) await db.execute(sql`update nexora_users set status='DISABLED' where id=${id}`);
  }
});

test("direct support creates an AUTHORIZED session with its audit action", async () => {
  const created = await open(deviceA);
  assert.ok(!("error" in created));
  assert.equal(created.session.status, "AUTHORIZED");
  const action = await db.execute(sql`select status, requires_two_person, requested_by, approved_by from nexora_privileged_actions where id = ${created.session.privilegedActionId}`);
  assert.equal(action.rows[0].status, "APPROVED");
  assert.equal(action.rows[0].requires_two_person, false);
  assert.equal(action.rows[0].requested_by, action.rows[0].approved_by);
  const audit = await db.execute(sql`select metadata from nexora_audit_log where target_id = ${created.session.id} and action = 'REMOTE_DESKTOP_AUTHORIZED'`);
  assert.equal(audit.rows[0].metadata.authorization_mode, "DIRECT_SUPPORT");
  assert.ok(created.session.privilegedActionId, "must be bound to an approval record");
  assert.ok(created.viewerToken.length >= 40);
  await closeSession(created.session.id, "CLOSED", "cleanup");
});

test("the viewer token is stored only as a hash", async () => {
  const created = await open(deviceA);
  const stored = await getSession(created.session.id);
  assert.notEqual(stored.viewerTokenHash, created.viewerToken, "raw token must not be stored");
  assert.equal(stored.viewerTokenHash, hashToken(created.viewerToken));
  assert.ok(tokenMatches(created.viewerToken, stored.viewerTokenHash));
  assert.ok(!tokenMatches("wrong-token", stored.viewerTokenHash));
  await closeSession(created.session.id, "CLOSED", "cleanup");
});

test("a second live session on the same device is refused", async () => {
  const first = await open(deviceA);
  assert.ok(!("error" in first));
  const second = await open(deviceA);
  assert.deepEqual(second, { error: "device_busy" });
  // A different device is unaffected by the first device's session.
  const other = await open(deviceB);
  assert.ok(!("error" in other));
  await closeSession(first.session.id, "CLOSED", "cleanup");
  await closeSession(other.session.id, "CLOSED", "cleanup");
});

test("closing a session frees the device for a new one", async () => {
  const first = await open(deviceA);
  await closeSession(first.session.id, "CLOSED", "viewer_closed");
  const second = await open(deviceA);
  assert.ok(!("error" in second), "device must be reusable once the session is closed");
  await closeSession(second.session.id, "CLOSED", "cleanup");
});

test("only an approved session can be claimed, and the token is single use", async () => {
  const created = await open(deviceA);
  // A legacy pending session is still unclaimable until explicitly authorized.
  await db.update(remoteDesktopSessionsTable).set({ status: "REQUESTED" }).where(eq(remoteDesktopSessionsTable.id, created.session.id));
  assert.equal(await claimForAgent(deviceA), null, "an unapproved session must not be claimable");

  const authorized = await authorizeSession(created.session.id, userId);
  assert.equal(authorized.status, "AUTHORIZED");

  const claim = await claimForAgent(deviceA);
  assert.ok(claim, "an approved session is claimable");
  assert.equal(claim.session.status, "CONNECTING");
  const stored = await getSession(created.session.id);
  assert.equal(stored.agentTokenHash, hashToken(claim.agentToken));

  // Already CONNECTING, so there is nothing left to claim.
  assert.equal(await claimForAgent(deviceA), null);
  await closeSession(created.session.id, "CLOSED", "cleanup");
});

test("approving twice does not re-authorize", async () => {
  const created = await open(deviceA);
  assert.equal(created.session.status, "AUTHORIZED");
  assert.equal(await authorizeSession(created.session.id, userId), null, "second approval must be a no-op");
  await closeSession(created.session.id, "CLOSED", "cleanup");
});

test("a terminated session clears its agent token so it cannot be replayed", async () => {
  const created = await open(deviceA);
  await authorizeSession(created.session.id, userId);
  const claim = await claimForAgent(deviceA);
  assert.ok(tokenMatches(claim.agentToken, (await getSession(created.session.id)).agentTokenHash));

  await closeSession(created.session.id, "CLOSED", "terminated_by_user");
  const closed = await getSession(created.session.id);
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.agentTokenHash, null);
  assert.ok(!tokenMatches(claim.agentToken, closed.agentTokenHash), "a closed session's token must be dead");
});

test("a terminal session cannot be reopened by another transition", async () => {
  const created = await open(deviceA);
  await closeSession(created.session.id, "CLOSED", "viewer_closed");
  assert.equal(await closeSession(created.session.id, "FAILED", "late"), null);
  assert.equal(await authorizeSession(created.session.id, userId), null);
  await markAgentConnected(created.session.id);
  assert.equal((await getSession(created.session.id)).status, "CLOSED", "status must stay terminal");
});

test("expiry is evaluated server-side and sweeps live sessions", async () => {
  const created = await open(deviceA);
  await db.update(remoteDesktopSessionsTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(remoteDesktopSessionsTable.id, created.session.id));

  const stale = await getSession(created.session.id);
  assert.ok(isExpired(stale));
  // An expired session cannot be promoted even though it is still REQUESTED.
  assert.equal(await authorizeSession(created.session.id, userId), null);

  const reaped = await expireStaleSessions();
  assert.ok(reaped.some((row) => row.id === created.session.id), "sweep must reap the expired session");
  const after = await getSession(created.session.id);
  assert.equal(after.status, "EXPIRED");
  assert.equal(after.agentTokenHash, null);

  // And the device is free again, which is what stops a dead session from
  // blocking the endpoint forever.
  const next = await open(deviceA);
  assert.ok(!("error" in next));
  await closeSession(next.session.id, "CLOSED", "cleanup");
});

test("an idle session is reaped even before its deadline", async () => {
  const created = await open(deviceA);
  await db.update(remoteDesktopSessionsTable)
    .set({ lastActivityAt: new Date(Date.now() - 60 * 60 * 1000) })
    .where(eq(remoteDesktopSessionsTable.id, created.session.id));
  const reaped = await expireStaleSessions();
  assert.ok(reaped.some((row) => row.id === created.session.id), "silence must be reaped, not just deadline");
});

test("screen geometry is recorded when the session goes active", async () => {
  const created = await open(deviceA);
  await authorizeSession(created.session.id, userId);
  await claimForAgent(deviceA);
  await markAgentConnected(created.session.id);
  await markActive(created.session.id, { width: 1920, height: 1080 });
  const active = await getSession(created.session.id);
  assert.equal(active.status, "ACTIVE");
  assert.equal(active.screenWidth, 1920);
  assert.equal(active.screenHeight, 1080);
  assert.ok(active.startedAt);
  await closeSession(created.session.id, "CLOSED", "cleanup");
});
