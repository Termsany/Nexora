import { pool } from "@workspace/db";
import { serviceEvents } from "./semantics.ts";
type QueryClient = { query<T extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

export type SnapshotMeta = { snapshot_id: string; collected_at: string; collection_status: "COMPLETE" | "PARTIAL" | "FAILED"; item_count: number; agent_version: string };
export type ServiceItem = { service_name: string; display_name: string; status: string; startup_type: string; logon_as?: string | null; service_type?: string | null; process_id?: number | null; binary_path?: string | null; description?: string | null; delayed_auto_start?: boolean | null };
export type ProcessItem = { pid: number; process_name: string; executable_path?: string | null; username?: string | null; cpu_time_seconds: number; cpu_percent?: number | null; working_set_bytes: number; private_memory_bytes?: number | null; thread_count?: number | null; handle_count?: number | null; started_at: string; architecture: string; session_id?: number | null };

async function beginSnapshot(client: QueryClient, deviceId: string, type: string, snapshot: SnapshotMeta) {
  const result = await client.query(`INSERT INTO nexora_inventory_snapshots(device_id,snapshot_id,inventory_type,collection_status,item_count,collected_at,agent_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (device_id,inventory_type,snapshot_id) DO NOTHING RETURNING id`,
    [deviceId, snapshot.snapshot_id, type, snapshot.collection_status, snapshot.item_count, new Date(snapshot.collected_at), snapshot.agent_version]);
  return Boolean(result.rowCount);
}

export async function reconcileServices(deviceId: string, snapshot: SnapshotMeta & { items: ServiceItem[] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!await beginSnapshot(client, deviceId, "services", snapshot)) { await client.query("ROLLBACK"); return { duplicate: true, baseline: false, present: 0, events: 0 }; }
    const device = await client.query<{ services_inventory_initialized_at: Date | null }>("SELECT services_inventory_initialized_at FROM nexora_devices WHERE id=$1 FOR UPDATE", [deviceId]);
    if (!device.rowCount) throw new Error("Device not found");
    if (snapshot.collection_status !== "COMPLETE") {
      await client.query("COMMIT");
      return { duplicate: false, baseline: false, present: 0, events: 0 };
    }
    const baseline = !device.rows[0]!.services_inventory_initialized_at && snapshot.collection_status === "COMPLETE";
    const existingRows = await client.query<{ service_name: string; status: string; startup_type: string; is_present: boolean }>("SELECT service_name,status,startup_type,is_present FROM nexora_device_services WHERE device_id=$1", [deviceId]);
    const existing = new Map(existingRows.rows.map(row => [row.service_name.toLowerCase(), row]));
    const seen = new Set<string>(); let events = 0;
    for (const item of snapshot.items) {
      const key = item.service_name.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      const previous = existing.get(key);
      await client.query(`INSERT INTO nexora_device_services(device_id,service_name,display_name,status,startup_type,logon_as,service_type,process_id,binary_path,description,delayed_auto_start,is_present,first_seen_at,last_seen_at,removed_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$12,null,$12)
        ON CONFLICT(device_id,service_name) DO UPDATE SET display_name=excluded.display_name,status=excluded.status,startup_type=excluded.startup_type,logon_as=excluded.logon_as,service_type=excluded.service_type,process_id=excluded.process_id,binary_path=excluded.binary_path,description=excluded.description,delayed_auto_start=excluded.delayed_auto_start,is_present=true,last_seen_at=excluded.last_seen_at,removed_at=null,updated_at=excluded.updated_at`,
        [deviceId,item.service_name,item.display_name,item.status,item.startup_type,item.logon_as??null,item.service_type??null,item.process_id??null,item.binary_path??null,item.description??null,item.delayed_auto_start??null,new Date(snapshot.collected_at)]);
      if (snapshot.collection_status === "COMPLETE" && !baseline) {
        const changes = serviceEvents(previous, item, baseline, true);
        for (const change of changes) { await client.query("INSERT INTO nexora_service_events(device_id,service_name,event_type,previous_value,new_value,observed_at,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [deviceId,item.service_name,change.type,change.previous,change.current,new Date(snapshot.collected_at),snapshot.snapshot_id]); events++; }
      }
    }
    if (snapshot.collection_status === "COMPLETE") {
      for (const previous of existing.values()) if (previous.is_present && !seen.has(previous.service_name.toLowerCase())) {
        await client.query("UPDATE nexora_device_services SET is_present=false,removed_at=$3,updated_at=$3 WHERE device_id=$1 AND service_name=$2", [deviceId,previous.service_name,new Date(snapshot.collected_at)]);
        if (!baseline) { await client.query("INSERT INTO nexora_service_events(device_id,service_name,event_type,previous_value,new_value,observed_at,snapshot_id) VALUES($1,$2,'SERVICE_REMOVED',$3,null,$4,$5) ON CONFLICT DO NOTHING", [deviceId,previous.service_name,previous.status,new Date(snapshot.collected_at),snapshot.snapshot_id]); events++; }
      }
      await client.query("UPDATE nexora_devices SET services_inventory_initialized_at=COALESCE(services_inventory_initialized_at,$2),services_last_collected_at=$2 WHERE id=$1", [deviceId,new Date(snapshot.collected_at)]);
    }
    await client.query("COMMIT"); return { duplicate: false, baseline, present: seen.size, events };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function reconcileProcesses(deviceId: string, snapshot: SnapshotMeta & { items: ProcessItem[] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!await beginSnapshot(client, deviceId, "processes", snapshot)) { await client.query("ROLLBACK"); return { duplicate: true, present: 0 }; }
    const seen: Array<[number, Date]> = [];
    for (const item of snapshot.items) {
      const started = new Date(item.started_at); seen.push([item.pid, started]);
      await client.query(`INSERT INTO nexora_device_processes_current(device_id,pid,process_name,executable_path,username,cpu_time_seconds,cpu_percent,working_set_bytes,private_memory_bytes,thread_count,handle_count,started_at,architecture,session_id,snapshot_id,last_seen_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
        ON CONFLICT(device_id,pid,started_at) DO UPDATE SET process_name=excluded.process_name,executable_path=excluded.executable_path,username=excluded.username,cpu_time_seconds=excluded.cpu_time_seconds,cpu_percent=excluded.cpu_percent,working_set_bytes=excluded.working_set_bytes,private_memory_bytes=excluded.private_memory_bytes,thread_count=excluded.thread_count,handle_count=excluded.handle_count,architecture=excluded.architecture,session_id=excluded.session_id,snapshot_id=excluded.snapshot_id,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
        [deviceId,item.pid,item.process_name,item.executable_path??null,item.username??null,item.cpu_time_seconds,item.cpu_percent??null,item.working_set_bytes,item.private_memory_bytes??null,item.thread_count??null,item.handle_count??null,started,item.architecture,item.session_id??null,snapshot.snapshot_id,new Date(snapshot.collected_at)]);
    }
    if (snapshot.collection_status === "COMPLETE") {
      await client.query("DELETE FROM nexora_device_processes_current WHERE device_id=$1 AND snapshot_id<>$2", [deviceId,snapshot.snapshot_id]);
      await client.query("UPDATE nexora_devices SET processes_last_collected_at=$2 WHERE id=$1", [deviceId,new Date(snapshot.collected_at)]);
    }
    await client.query("COMMIT"); return { duplicate: false, present: seen.length };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function cleanupRuntimeInventory(now = new Date()) {
  const processCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const generalCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const snapshots = await pool.query("DELETE FROM nexora_inventory_snapshots WHERE (inventory_type='processes' AND received_at<$1) OR received_at<$2", [processCutoff, generalCutoff]);
  const events = await pool.query("DELETE FROM nexora_service_events WHERE observed_at<$1", [generalCutoff]);
  return { snapshots: snapshots.rowCount ?? 0, serviceEvents: events.rowCount ?? 0 };
}
