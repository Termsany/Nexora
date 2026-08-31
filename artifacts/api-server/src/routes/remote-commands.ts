import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agentCredentialsTable, agentRequestNoncesTable, agentSigningKeysTable, db, devicesTable, privilegedActionsTable, remoteCommandJobsTable } from "@workspace/db";
import { canonicalAgentRequest, verifyAgentSignature } from "../security/agent-signing.ts";
import { z } from "zod";
import { requirePermission, requireTenantContext } from "../tenancy/context.ts";
import { hasPermission, organizationScope } from "../tenancy/policy.ts";
import { recordAudit } from "../tenancy/audit.ts";

const router: IRouter = Router();
const uuid = z.string().uuid();
const enabled = () => process.env.REMOTE_COMMANDS_ENABLED === "true";
const commandSchema = z.object({ device_id: uuid, shell: z.enum(["CMD", "POWERSHELL"]), command: z.string().trim().min(1).max(64 * 1024), timeout_seconds: z.coerce.number().int().min(1).max(900).default(60), reason: z.string().trim().min(1).max(1000), working_directory: z.string().max(260).optional() });
async function agentDevice(req: any) { const raw = req.headers.authorization; if (!raw?.startsWith("Bearer ")) return null; const hash = crypto.createHash("sha256").update(raw.slice(7)).digest("hex"); const [row] = await db.select({ device: devicesTable }).from(agentCredentialsTable).innerJoin(devicesTable, eq(agentCredentialsTable.deviceId, devicesTable.id)).where(and(eq(agentCredentialsTable.tokenHash, hash), sql`${agentCredentialsTable.revokedAt} is null`)); return row?.device ?? null; }
async function signedAgent(req: any, res: any) { const device = await agentDevice(req); if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return null; } const h=req.headers; const version=h["x-nexora-signature-version"], keyId=h["x-nexora-key-id"], ts=h["x-nexora-timestamp"], nonce=h["x-nexora-nonce"], sig=h["x-nexora-signature"]; if(version!=="nexora-agent-sign-v1"||!keyId||!ts||!nonce||!sig){res.status(401).json({error:"Signed request required"});return null;} const timestamp=Number(ts); if(!Number.isFinite(timestamp)||Math.abs(Date.now()/1000-timestamp)>300){res.status(401).json({error:"Invalid signed request"});return null;} const [key]=await db.select().from(agentSigningKeysTable).where(and(eq(agentSigningKeysTable.id,keyId),eq(agentSigningKeysTable.deviceId,device.id),eq(agentSigningKeysTable.status,"ACTIVE"))); if(!key||!verifyAgentSignature(key.publicKey,canonicalAgentRequest(req.method,req.path,(req.rawBody??Buffer.from("")),ts,nonce,device.agentId,key.id),sig)){res.status(401).json({error:"Invalid signed request"});return null;} try { await db.insert(agentRequestNoncesTable).values({deviceId:device.id,signingKeyId:key.id,nonceHash:crypto.createHash("sha256").update(nonce).digest("hex"),requestTimestamp:timestamp,expiresAt:new Date((timestamp+600)*1000)}); } catch { res.status(409).json({error:"Replay rejected"}); return null; } return device; }

router.post("/v1/agent/signing-key", async (req, res): Promise<void> => {
  const device = await agentDevice(req); if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = z.object({ algorithm: z.literal("ECDSA_P256_SHA256"), public_key: z.string().min(80).max(4096), protocol_version: z.literal("remote_command_v1") }).safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: "Invalid signing key" }); return; }
  const fingerprint = crypto.createHash("sha256").update(parsed.data.public_key).digest("hex");
  const [existing] = await db.select().from(agentSigningKeysTable).where(and(eq(agentSigningKeysTable.deviceId, device.id), eq(agentSigningKeysTable.status, "ACTIVE")));
  if (existing) { if (existing.keyFingerprint === fingerprint) { res.json({ key_id: existing.id, key_fingerprint: existing.keyFingerprint, status: existing.status }); return; } res.status(409).json({ error: "Active signing key already exists" }); return; }
  const [created] = await db.insert(agentSigningKeysTable).values({ deviceId: device.id, algorithm: parsed.data.algorithm, publicKey: parsed.data.public_key, keyFingerprint: fingerprint, protocolVersion: parsed.data.protocol_version }).returning({ id: agentSigningKeysTable.id, keyFingerprint: agentSigningKeysTable.keyFingerprint, status: agentSigningKeysTable.status });
  res.status(201).json({ key_id: created!.id, key_fingerprint: created!.keyFingerprint, status: created!.status });
});

router.post("/v1/agent/remote-commands/claim", async (req, res): Promise<void> => {
  const device = await signedAgent(req,res); if (!device) return;
  if (!enabled() || !device.remoteCommandsEnabled || !Array.isArray(device.capabilities) || !device.capabilities.includes("remote_command_v1")) { res.status(204).end(); return; }
  const [job] = await db.select().from(remoteCommandJobsTable).where(and(eq(remoteCommandJobsTable.deviceId, device.id), eq(remoteCommandJobsTable.status, "READY"), sql`${remoteCommandJobsTable.expiresAt} > now()`)).orderBy(remoteCommandJobsTable.createdAt).limit(1);
  if (!job) { res.status(204).end(); return; }
  const executionId = crypto.randomUUID(); const capability = crypto.randomBytes(32).toString("base64url");
  const [claimed] = await db.update(remoteCommandJobsTable).set({ status: "CLAIMED", claimedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000), executionId, executionCapabilityHash: crypto.createHash("sha256").update(capability).digest("hex"), executionAttempt: sql`${remoteCommandJobsTable.executionAttempt} + 1`, updatedAt: new Date() }).where(and(eq(remoteCommandJobsTable.id, job.id), eq(remoteCommandJobsTable.status, "READY"))).returning();
  if (!claimed) { res.status(204).end(); return; } res.json({ id: claimed.id, execution_id: executionId, execution_capability: capability, shell: claimed.shellType, command: (claimed.commandPayload as any).command, timeout_seconds: claimed.timeoutSeconds, working_directory: claimed.workingDirectory });
});

async function executionRequest(req: any, res: any, action: "start" | "heartbeat" | "result") {
  const device = await signedAgent(req,res); if (!device) return;
  const idResult = uuid.safeParse(req.params.id); const body = z.object({ execution_id: uuid, execution_capability: z.string().min(20).max(200), exit_code: z.number().int().optional(), stdout: z.string().max(1024 * 1024).optional(), stderr: z.string().max(1024 * 1024).optional(), stdout_truncated: z.boolean().optional(), stderr_truncated: z.boolean().optional() }).safeParse(req.body); if (!idResult.success || !body.success) { res.status(400).json({ error: "Invalid execution request" }); return; }
  const [job] = await db.select().from(remoteCommandJobsTable).where(and(eq(remoteCommandJobsTable.id, idResult.data), eq(remoteCommandJobsTable.deviceId, device.id))); if (!job || job.executionId !== body.data.execution_id || job.executionCapabilityHash !== crypto.createHash("sha256").update(body.data.execution_capability).digest("hex")) { res.status(404).json({ error: "Not found" }); return; }
  if (action === "start") { if (job.status === "RUNNING") { res.json(job); return; } if (job.status !== "CLAIMED") { res.status(409).json({ error: "Invalid state" }); return; } const [updated] = await db.update(remoteCommandJobsTable).set({ status: "RUNNING", startedAt: new Date(), lastExecutionHeartbeatAt: new Date(), updatedAt: new Date() }).where(and(eq(remoteCommandJobsTable.id, job.id), eq(remoteCommandJobsTable.status, "CLAIMED"))).returning(); res.json(updated); return; }
  if (action === "heartbeat") { if (!["CLAIMED", "RUNNING"].includes(job.status)) { res.status(409).json({ error: "Invalid state" }); return; } const [updated] = await db.update(remoteCommandJobsTable).set({ lastExecutionHeartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000), updatedAt: new Date() }).where(eq(remoteCommandJobsTable.id, job.id)).returning(); res.json(updated); return; }
  if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status)) { res.json(job); return; } const terminal = body.data.exit_code === 0 ? "SUCCEEDED" : "FAILED"; const [updated] = await db.update(remoteCommandJobsTable).set({ status: terminal as any, completedAt: new Date(), exitCode: body.data.exit_code ?? null, stdout: body.data.stdout ?? null, stderr: body.data.stderr ?? null, stdoutTruncated: body.data.stdout_truncated ?? false, stderrTruncated: body.data.stderr_truncated ?? false, updatedAt: new Date() }).where(eq(remoteCommandJobsTable.id, job.id)).returning(); res.json(updated);
}
router.post("/v1/agent/remote-commands/:id/start", (req, res) => executionRequest(req, res, "start"));
router.post("/v1/agent/remote-commands/:id/heartbeat", (req, res) => executionRequest(req, res, "heartbeat"));
router.post("/v1/agent/remote-commands/:id/result", (req, res) => executionRequest(req, res, "result"));
router.post("/v1/agent/remote-commands/:id/status", async (req, res) => {
  const device = await signedAgent(req,res); if (!device) return;
  const parsed = uuid.safeParse(req.params.id); if (!parsed.success) { res.status(404).json({ error: "Not found" }); return; }
  const [job] = await db.select({ id: remoteCommandJobsTable.id, status: remoteCommandJobsTable.status, cancelRequestedAt: remoteCommandJobsTable.cancelRequestedAt }).from(remoteCommandJobsTable).where(and(eq(remoteCommandJobsTable.id, parsed.data), eq(remoteCommandJobsTable.deviceId, device.id)));
  if (!job) { res.status(404).json({ error: "Not found" }); return; } res.json({ status: job.status, cancel_requested: Boolean(job.cancelRequestedAt) });
});

router.post("/v1/remote-commands", requireTenantContext, requirePermission("remote_commands.request"), async (req, res): Promise<void> => {
  if (!enabled()) { res.status(503).json({ error: "Remote commands are disabled" }); return; }
  const parsed = commandSchema.safeParse(req.body); const context = req.tenant!;
  if (!parsed.success || !context.userId) { res.status(400).json({ error: "Invalid command request" }); return; }
  const body = parsed.data; const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, body.device_id));
  if (!device || !hasPermission(context, "remote_commands.request", device.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const [action] = await db.insert(privilegedActionsTable).values({ organizationId: device.organizationId, deviceId: device.id, actionType: "REMOTE_COMMAND", requestedBy: context.userId, expiresAt, requestReason: body.reason, safeParameters: { shell: body.shell, command: body.command, timeout_seconds: body.timeout_seconds, working_directory: body.working_directory ?? null } }).returning();
  const [job] = await db.insert(remoteCommandJobsTable).values({ organizationId: device.organizationId, deviceId: device.id, privilegedActionId: action!.id, shellType: body.shell, commandPayload: { shell: body.shell, command: body.command, reason: body.reason }, workingDirectory: body.working_directory, timeoutSeconds: body.timeout_seconds, requestedByUserId: context.userId, expiresAt }).returning();
  await recordAudit({ action: "REMOTE_COMMAND_REQUESTED", context, organizationId: device.organizationId, targetType: "remote_command", targetId: job!.id, req });
  res.status(201).json(job);
});

router.get("/v1/remote-commands", requireTenantContext, requirePermission("remote_commands.read"), async (req, res): Promise<void> => {
  const context = req.tenant!; const scope = organizationScope(context, typeof req.query.organization === "string" ? req.query.organization : undefined); if (!scope.ok) { res.status(404).json({ error: "Not found" }); return; }
  const where = scope.organizationIds ? (scope.organizationIds.length ? inArray(remoteCommandJobsTable.organizationId, scope.organizationIds) : sql`false`) : undefined;
  const rows = await db.select().from(remoteCommandJobsTable).where(where).orderBy(desc(remoteCommandJobsTable.createdAt)).limit(100); res.json({ items: rows });
});

router.get("/v1/remote-commands/:id", requireTenantContext, requirePermission("remote_commands.read"), async (req, res): Promise<void> => {
  const context = req.tenant!; const parsed = uuid.safeParse(req.params.id); if (!parsed.success) { res.status(404).json({ error: "Not found" }); return; }
  const [row] = await db.select().from(remoteCommandJobsTable).where(eq(remoteCommandJobsTable.id, parsed.data)); if (!row || !hasPermission(context, "remote_commands.read", row.organizationId)) { res.status(404).json({ error: "Not found" }); return; } res.json(row);
});

router.post("/v1/remote-commands/:id/cancel", requireTenantContext, requirePermission("remote_commands.cancel"), async (req, res): Promise<void> => {
  const context = req.tenant!; const parsed = uuid.safeParse(req.params.id); if (!parsed.success) { res.status(404).json({ error: "Not found" }); return; }
  const [row] = await db.select().from(remoteCommandJobsTable).where(eq(remoteCommandJobsTable.id, parsed.data)); if (!row || !hasPermission(context, "remote_commands.cancel", row.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  if (!["PENDING", "READY", "CLAIMED", "RUNNING"].includes(row.status)) { res.status(409).json({ error: "Command is no longer cancellable" }); return; }
  const next = ["PENDING", "READY"].includes(row.status) ? "CANCELLED" : "CANCEL_REQUESTED";
  const [updated] = await db.update(remoteCommandJobsTable).set({ status: next as any, cancelRequestedAt: new Date(), updatedAt: new Date() }).where(and(eq(remoteCommandJobsTable.id, row.id), eq(remoteCommandJobsTable.status, row.status))).returning();
  await recordAudit({ action: next === "CANCELLED" ? "REMOTE_COMMAND_CANCELLED" : "REMOTE_COMMAND_CANCEL_REQUESTED", context, organizationId: row.organizationId, targetType: "remote_command", targetId: row.id, req }); res.json(updated);
});

export default router;
