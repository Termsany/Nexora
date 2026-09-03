import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { findDeviceInScope, organizationScope, tenantSqlClause } from "../tenancy/scope.ts";

const router: IRouter = Router();

router.use("/v1/devices/:device_id/services", requireTenantContext);
router.use("/v1/devices/:device_id/service-events", requireTenantContext);
router.use("/v1/devices/:device_id/processes", requireTenantContext);
router.use("/v1/services", requireTenantContext);

const id = z.string().uuid();
const page = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) });

/**
 * Resolves the device for a per-device inventory route. Returns false after
 * having already answered 400/403/404, so callers just return.
 *
 * Services and processes expose command lines, binary paths and the accounts
 * services run as; none of that may cross a tenant boundary (§R), so the
 * device is resolved through the caller's scope rather than merely checked for
 * existence as it was before Task #008.
 */
async function resolveDevice(req: Parameters<Parameters<IRouter["get"]>[1]>[0], res: Parameters<Parameters<IRouter["get"]>[1]>[1]) {
  const context = req.tenant!;
  if (!can(context, "inventory:read")) { res.status(403).json({ error: "Insufficient permissions" }); return null; }
  const parsed = id.safeParse(req.params.device_id);
  if (!parsed.success) { res.status(400).json({ error: "Invalid device ID" }); return null; }
  const device = await findDeviceInScope(context, parsed.data);
  if (!device) { res.status(404).json({ error: "Device not found" }); return null; }
  return device;
}

router.get("/v1/devices/:device_id/services", async (req, res): Promise<void> => {
  const device = await resolveDevice(req, res); if (!device) return;
  const query = page.extend({ search: z.string().trim().max(200).optional(), status: z.enum(["RUNNING","STOPPED","PAUSED","START_PENDING","STOP_PENDING","PAUSE_PENDING","CONTINUE_PENDING","UNKNOWN"]).optional(), startup_type: z.enum(["AUTOMATIC","AUTOMATIC_DELAYED","MANUAL","DISABLED","BOOT","SYSTEM","UNKNOWN"]).optional(), present: z.enum(["true","false","all"]).default("true"), sort: z.enum(["service_name","display_name","status","startup_type","last_seen_at"]).default("service_name"), direction: z.enum(["asc","desc"]).default("asc") }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid services query" }); return; }
  const values: unknown[] = [device.id], filters = ["device_id=$1"];
  if (query.data.present !== "all") { values.push(query.data.present === "true"); filters.push(`is_present=$${values.length}`); }
  if (query.data.search) { values.push(`%${query.data.search}%`); filters.push(`(service_name ILIKE $${values.length} OR display_name ILIKE $${values.length})`); }
  if (query.data.status) { values.push(query.data.status); filters.push(`status=$${values.length}`); }
  if (query.data.startup_type) { values.push(query.data.startup_type); filters.push(`startup_type=$${values.length}`); }
  const where = filters.join(" AND "), total = await pool.query(`SELECT count(*)::int total FROM nexora_device_services WHERE ${where}`, values);
  values.push(query.data.page_size, (query.data.page - 1) * query.data.page_size);
  const sort = { service_name: "lower(service_name)", display_name: "lower(display_name)", status: "status", startup_type: "startup_type", last_seen_at: "last_seen_at" }[query.data.sort];
  const rows = await pool.query(`SELECT id,service_name,display_name,status,startup_type,logon_as,service_type,process_id,binary_path,description,delayed_auto_start,is_present,first_seen_at,last_seen_at,removed_at FROM nexora_device_services WHERE ${where} ORDER BY ${sort} ${query.data.direction},id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.data.page, page_size: query.data.page_size, total: total.rows[0]?.total ?? 0 });
});

router.get("/v1/devices/:device_id/service-events", async (req, res): Promise<void> => {
  const device = await resolveDevice(req, res); if (!device) return;
  const query = page.extend({ service_name: z.string().max(256).optional(), event_type: z.enum(["STATUS_CHANGED","STARTUP_TYPE_CHANGED","SERVICE_ADDED","SERVICE_REMOVED"]).optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid service events query" }); return; }
  const values: unknown[] = [device.id], filters = ["device_id=$1"];
  for (const [field, value] of [["service_name", query.data.service_name], ["event_type", query.data.event_type]] as const) if (value) { values.push(value); filters.push(`${field}=$${values.length}`); }
  if (query.data.from) { values.push(new Date(query.data.from)); filters.push(`observed_at>=$${values.length}`); }
  if (query.data.to) { values.push(new Date(query.data.to)); filters.push(`observed_at<=$${values.length}`); }
  const where = filters.join(" AND "), total = await pool.query(`SELECT count(*)::int total FROM nexora_service_events WHERE ${where}`, values);
  values.push(query.data.page_size, (query.data.page - 1) * query.data.page_size);
  const rows = await pool.query(`SELECT id,service_name,event_type,previous_value,new_value,observed_at,snapshot_id FROM nexora_service_events WHERE ${where} ORDER BY observed_at DESC,id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.data.page, page_size: query.data.page_size, total: total.rows[0]?.total ?? 0 });
});

const processQuery = page.extend({ search: z.string().trim().max(200).optional(), username: z.string().trim().max(512).optional(), sort: z.enum(["process_name","cpu_percent","working_set_bytes","started_at"]).default("process_name"), direction: z.enum(["asc","desc"]).default("asc") });

router.get("/v1/devices/:device_id/processes", async (req, res): Promise<void> => {
  const device = await resolveDevice(req, res); if (!device) return;
  const query = processQuery.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid processes query" }); return; }
  const values: unknown[] = [device.id], filters = ["device_id=$1"];
  if (query.data.search) { values.push(`%${query.data.search}%`); filters.push(`(process_name ILIKE $${values.length} OR COALESCE(executable_path,'') ILIKE $${values.length})`); }
  if (query.data.username) { values.push(query.data.username); filters.push(`username=$${values.length}`); }
  const where = filters.join(" AND "), total = await pool.query(`SELECT count(*)::int total FROM nexora_device_processes_current WHERE ${where}`, values);
  values.push(query.data.page_size, (query.data.page - 1) * query.data.page_size);
  const sort = { process_name: "lower(process_name)", cpu_percent: "cpu_percent", working_set_bytes: "working_set_bytes", started_at: "started_at" }[query.data.sort];
  const rows = await pool.query(`SELECT id,pid,process_name,executable_path,username,cpu_time_seconds,cpu_percent,working_set_bytes,private_memory_bytes,thread_count,handle_count,started_at,architecture,session_id,last_seen_at FROM nexora_device_processes_current WHERE ${where} ORDER BY ${sort} ${query.data.direction} NULLS LAST,id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows.map((row) => ({ ...row, working_set_bytes: Number(row.working_set_bytes), private_memory_bytes: row.private_memory_bytes == null ? null : Number(row.private_memory_bytes) })), page: query.data.page, page_size: query.data.page_size, total: total.rows[0]?.total ?? 0 });
});

router.get("/v1/devices/:device_id/processes/summary", async (req, res): Promise<void> => {
  const device = await resolveDevice(req, res); if (!device) return;
  const summary = await pool.query(`SELECT count(*)::int total_processes,COALESCE(sum(working_set_bytes),0)::text total_working_set_bytes,max(last_seen_at) last_collected_at FROM nexora_device_processes_current WHERE device_id=$1`, [device.id]);
  const cpu = await pool.query("SELECT process_name,pid,cpu_percent FROM nexora_device_processes_current WHERE device_id=$1 AND cpu_percent IS NOT NULL ORDER BY cpu_percent DESC LIMIT 5", [device.id]);
  const memory = await pool.query("SELECT process_name,pid,working_set_bytes FROM nexora_device_processes_current WHERE device_id=$1 ORDER BY working_set_bytes DESC LIMIT 5", [device.id]);
  res.json({ ...summary.rows[0], total_working_set_bytes: Number(summary.rows[0]?.total_working_set_bytes ?? 0), top_cpu: cpu.rows, top_memory: memory.rows.map((row) => ({ ...row, working_set_bytes: Number(row.working_set_bytes) })) });
});

/**
 * Fleet-wide service catalogue. Like the software equivalent, the grouping and
 * the total are computed over tenant-scoped rows only, so the per-service
 * device counts reflect the caller's own estate (§R, §AH).
 */
router.get("/v1/services", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "inventory:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const query = page.extend({ search: z.string().trim().max(200).optional(), organization_id: z.string().uuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid services query" }); return; }
  const scope = organizationScope(context, query.data.organization_id);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const filters = ["s.is_present=true", tenantSqlClause("d.organization_id", scope.organizationIds, values)];
  if (query.data.search) { values.push(`%${query.data.search}%`); filters.push(`(s.service_name ILIKE $${values.length} OR s.display_name ILIKE $${values.length})`); }
  const where = filters.join(" AND ");
  const total = await pool.query(`SELECT count(*)::int total FROM (
    SELECT lower(s.service_name) FROM nexora_device_services s
    JOIN nexora_devices d ON d.id = s.device_id
    WHERE ${where} GROUP BY lower(s.service_name)) q`, values);
  values.push(query.data.page_size, (query.data.page - 1) * query.data.page_size);
  const rows = await pool.query(`SELECT lower(s.service_name) identity,(array_agg(s.service_name ORDER BY s.last_seen_at DESC))[1] service_name,(array_agg(s.display_name ORDER BY s.last_seen_at DESC))[1] display_name,
    count(*)::int devices_installed,count(*) FILTER(WHERE s.status='RUNNING')::int running,count(*) FILTER(WHERE s.status='STOPPED')::int stopped,count(*) FILTER(WHERE s.startup_type='DISABLED')::int disabled
    FROM nexora_device_services s JOIN nexora_devices d ON d.id = s.device_id
    WHERE ${where} GROUP BY lower(s.service_name)
    ORDER BY lower((array_agg(s.display_name ORDER BY s.last_seen_at DESC))[1]) LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  res.json({ items: rows.rows, page: query.data.page, page_size: query.data.page_size, total: total.rows[0]?.total ?? 0 });
});

export default router;
