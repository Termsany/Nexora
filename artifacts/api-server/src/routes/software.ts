import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { findDeviceInScope, organizationScope, tenantSqlClause } from "../tenancy/scope.ts";

const router: IRouter = Router();
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(), publisher: z.string().trim().max(300).optional(),
  architecture: z.enum(["x64", "x86", "unknown"]).optional(), present: z.enum(["true", "false", "all"]).default("true"),
  version: z.string().trim().max(200).optional(), sort: z.enum(["name", "version", "publisher", "first_seen", "last_seen"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  organization_id: z.string().uuid().optional(),
});

router.use("/v1/software", requireTenantContext);
router.use("/v1/devices/:device_id/software", requireTenantContext);

function parsePage(query: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  const parsed = pageQuery.safeParse(query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return null; }
  return parsed.data;
}

router.get("/v1/devices/:device_id/software", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "software:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const deviceId = z.string().uuid().safeParse(req.params.device_id); const query = parsePage(req.query, res);
  if (!deviceId.success || !query) { if (!deviceId.success) res.status(400).json({ error: "Invalid device ID" }); return; }
  if (!await findDeviceInScope(context, deviceId.data)) { res.status(404).json({ error: "Device not found" }); return; }

  const values: unknown[] = [deviceId.data]; const conditions = ["s.device_id=$1"];
  if (query.present !== "all") { values.push(query.present === "true"); conditions.push(`s.is_present=$${values.length}`); }
  if (query.search) { values.push(`%${query.search}%`); conditions.push(`(s.name ILIKE $${values.length} OR COALESCE(s.publisher,'') ILIKE $${values.length})`); }
  if (query.publisher) { values.push(query.publisher); conditions.push(`s.publisher=$${values.length}`); }
  if (query.architecture) { values.push(query.architecture); conditions.push(`s.architecture=$${values.length}`); }
  if (query.version) { values.push(query.version); conditions.push(`s.version=$${values.length}`); }
  const sort = { name: "s.normalized_name", version: "s.version", publisher: "s.publisher", first_seen: "s.first_seen_at", last_seen: "s.last_seen_at" }[query.sort];
  const where = conditions.join(" AND "); const offset = (query.page - 1) * query.page_size;
  const count = await pool.query(`SELECT count(*)::int total FROM nexora_device_software s WHERE ${where}`, values);
  values.push(query.page_size, offset);
  const rows = await pool.query(`SELECT s.id,s.software_identity,s.name,s.version,s.publisher,s.architecture,s.install_date,s.install_location,
    s.source,s.system_component,s.uninstall_available,s.first_seen_at,s.last_seen_at,s.is_present,s.removed_at
    FROM nexora_device_software s WHERE ${where} ORDER BY ${sort} ${query.direction},s.id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.page, page_size: query.page_size, total: count.rows[0]?.total ?? 0 });
});

router.get("/v1/devices/:device_id/software/changes", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "software:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const deviceId = z.string().uuid().safeParse(req.params.device_id);
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25), change_type: z.enum(["INSTALLED", "REMOVED", "VERSION_CHANGED"]).optional() }).safeParse(req.query);
  if (!deviceId.success || !query.success) { res.status(400).json({ error: "Invalid change history query" }); return; }
  if (!await findDeviceInScope(context, deviceId.data)) { res.status(404).json({ error: "Device not found" }); return; }

  const values: unknown[] = [deviceId.data]; let filter = "";
  if (query.data.change_type) { values.push(query.data.change_type); filter = ` AND change_type=$${values.length}`; }
  const count = await pool.query(`SELECT count(*)::int total FROM nexora_software_changes WHERE device_id=$1${filter}`, values);
  values.push(query.data.page_size, (query.data.page - 1) * query.data.page_size);
  const rows = await pool.query(`SELECT id,software_identity,change_type,name,publisher,previous_version,current_version,observed_at
    FROM nexora_software_changes WHERE device_id=$1${filter} ORDER BY observed_at DESC,id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.data.page, page_size: query.data.page_size, total: count.rows[0]?.total ?? 0 });
});

/**
 * Fleet-wide software inventory.
 *
 * Every aggregate — the application list, the per-version endpoint counts and
 * the total — is computed from a base set that already joins devices and
 * applies the tenant predicate. An organization user therefore sees only their
 * own installations and their own version distribution, never a fleet-wide
 * count that would disclose how much software other tenants run (§Q, §AH).
 */
router.get("/v1/software", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "software:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const query = parsePage(req.query, res); if (!query) return;
  const scope = organizationScope(context, query.organization_id);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const filters = ["s.is_present=true", tenantSqlClause("d.organization_id", scope.organizationIds, values)];
  if (query.search) { values.push(`%${query.search}%`); filters.push(`(s.name ILIKE $${values.length} OR COALESCE(s.publisher,'') ILIKE $${values.length})`); }
  if (query.publisher) { values.push(query.publisher); filters.push(`s.publisher=$${values.length}`); }
  if (query.architecture) { values.push(query.architecture); filters.push(`s.architecture=$${values.length}`); }
  if (query.version) { values.push(query.version); filters.push(`s.version=$${values.length}`); }
  const where = filters.join(" AND ");

  const count = await pool.query(`SELECT count(*)::int total FROM (
    SELECT s.software_identity FROM nexora_device_software s
    JOIN nexora_devices d ON d.id = s.device_id
    WHERE ${where} GROUP BY s.software_identity) grouped`, values);
  values.push(query.page_size, (query.page - 1) * query.page_size);
  const rows = await pool.query(`WITH base AS (
      SELECT s.* FROM nexora_device_software s
      JOIN nexora_devices d ON d.id = s.device_id
      WHERE ${where}),
    apps AS (SELECT software_identity,(array_agg(name ORDER BY last_seen_at DESC))[1] name,(array_agg(publisher ORDER BY last_seen_at DESC))[1] publisher,
      architecture,count(*)::int installed_endpoints,max(last_seen_at) latest_observed FROM base GROUP BY software_identity,architecture),
    versions AS (SELECT software_identity,version,count(*)::int endpoints FROM base GROUP BY software_identity,version)
    SELECT apps.*,(SELECT jsonb_agg(jsonb_build_object('version',v.version,'endpoints',v.endpoints) ORDER BY v.endpoints DESC,v.version) FROM versions v WHERE v.software_identity=apps.software_identity) versions
    FROM apps ORDER BY lower(apps.name) LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.page, page_size: query.page_size, total: count.rows[0]?.total ?? 0 });
});

router.get("/v1/software/:software_identity/devices", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "software:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const identity = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.params.software_identity); const query = parsePage(req.query, res);
  if (!identity.success || !query) { if (!identity.success) res.status(400).json({ error: "Invalid software identity" }); return; }
  const scope = organizationScope(context, query.organization_id);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [identity.data];
  const filters = ["s.software_identity=$1", "s.is_present=true", tenantSqlClause("d.organization_id", scope.organizationIds, values)];
  if (query.version) { values.push(query.version); filters.push(`s.version=$${values.length}`); }
  if (query.search) { values.push(`%${query.search}%`); filters.push(`d.hostname ILIKE $${values.length}`); }
  const where = filters.join(" AND ");
  const count = await pool.query(`SELECT count(*)::int total FROM nexora_device_software s JOIN nexora_devices d ON d.id=s.device_id WHERE ${where}`, values);
  values.push(query.page_size, (query.page - 1) * query.page_size);
  const rows = await pool.query(`SELECT d.id device_id,d.hostname,d.agent_id,d.status,d.organization_id,s.version,s.architecture,s.last_seen_at
    FROM nexora_device_software s JOIN nexora_devices d ON d.id=s.device_id WHERE ${where} ORDER BY d.hostname LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.page, page_size: query.page_size, total: count.rows[0]?.total ?? 0 });
});

export default router;
