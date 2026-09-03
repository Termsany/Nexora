import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogTable, db, enrollmentTokensTable } from "@workspace/db";

const router: IRouter = Router();

function authorized(req: { headers: { authorization?: string } }) {
  const configured = process.env.ADMIN_API_TOKEN;
  if (!configured) return process.env.NODE_ENV !== "production";
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(configured);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

router.use("/v1/admin", (req, res, next) => {
  if (!authorized(req)) { res.status(401).json({ error: "Administrative authorization required" }); return; }
  next();
});

router.get("/v1/admin/enrollment-tokens", async (_req, res) => {
  const tokens = await db.select({
    id: enrollmentTokensTable.id,
    name: enrollmentTokensTable.name,
    organization: enrollmentTokensTable.organization,
    expires_at: enrollmentTokensTable.expiresAt,
    max_uses: enrollmentTokensTable.maxUses,
    current_uses: enrollmentTokensTable.uses,
    created_at: enrollmentTokensTable.createdAt,
    revoked_at: enrollmentTokensTable.revokedAt,
    active: enrollmentTokensTable.active,
  }).from(enrollmentTokensTable).orderBy(desc(enrollmentTokensTable.createdAt));
  res.json(tokens);
});

router.post("/v1/admin/enrollment-tokens", async (req, res): Promise<void> => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    organization: z.string().trim().min(1).max(120).default("Default"),
    expires_at: z.coerce.date().refine((value) => value.getTime() > Date.now(), "Expiration must be in the future"),
    max_uses: z.number().int().min(1).max(10000).default(1),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rawToken = `nxen_${crypto.randomBytes(32).toString("base64url")}`;
  const [created] = await db.insert(enrollmentTokensTable).values({
    name: parsed.data.name,
    organization: parsed.data.organization,
    expiresAt: parsed.data.expires_at,
    maxUses: parsed.data.max_uses,
    tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
  }).returning();
  await db.insert(auditLogTable).values({ action: "ENROLLMENT_TOKEN_CREATED", subjectId: created.id, metadata: { name: created.name, organization: created.organization } });
  res.status(201).json({
    id: created.id,
    name: created.name,
    organization: created.organization,
    expires_at: created.expiresAt,
    max_uses: created.maxUses,
    current_uses: created.uses,
    created_at: created.createdAt,
    revoked_at: created.revokedAt,
    active: created.active,
    token: rawToken,
  });
});

router.post("/v1/admin/enrollment-tokens/:token_id/revoke", async (req, res): Promise<void> => {
  const tokenId = z.string().uuid().safeParse(req.params.token_id);
  if (!tokenId.success) { res.status(400).json({ error: "Invalid token ID" }); return; }
  const [revoked] = await db.update(enrollmentTokensTable)
    .set({ active: false, revokedAt: new Date() })
    .where(eq(enrollmentTokensTable.id, tokenId.data))
    .returning({ id: enrollmentTokensTable.id });
  if (!revoked) { res.status(404).json({ error: "Enrollment token not found" }); return; }
  await db.insert(auditLogTable).values({ action: "ENROLLMENT_TOKEN_REVOKED", subjectId: revoked.id });
  res.sendStatus(204);
});

export default router;
