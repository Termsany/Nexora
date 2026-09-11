import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
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

before(async () => {
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
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

const open = (deviceId) => createSession({ organizationId: orgId, siteId: null, deviceId, userId, reason: "integration test" });

test("a session is created behind a privileged action and starts REQUESTED", async () => {
  const created = await open(deviceA);
  assert.ok(!("error" in created));
  assert.equal(created.session.status, "REQUESTED");
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
  assert.ok(await authorizeSession(created.session.id, userId));
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
