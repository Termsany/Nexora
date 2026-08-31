import { pool } from "@workspace/db";
import { normalizeSoftwareText, sanitizeSoftwareText, softwareIdentity, type SoftwareArchitecture } from "./identity.ts";

export type SoftwareInput = {
  name: string; version?: string | null; publisher?: string | null; install_date?: string | null;
  install_location?: string | null; uninstall_available: boolean; product_code?: string | null;
  architecture: SoftwareArchitecture; source: string; system_component: boolean; identity?: string;
};

export type SoftwareSnapshotInput = { complete: boolean; collected_at: string; error_code?: string | null; entries: SoftwareInput[] };

export async function reconcileSoftwareSnapshot(deviceId: string, snapshot: SoftwareSnapshotInput, observedAt = new Date()) {
  if (!snapshot.complete) return { skipped: true, present: 0, installed: 0, removed: 0, versionChanged: 0, baseline: false };
  const unique = new Map<string, SoftwareInput & { identity: string; normalizedName: string }>();
  for (const item of snapshot.entries) {
    const name = sanitizeSoftwareText(item.name);
    if (!name) continue;
    const cleanItem = { ...item, name, version: sanitizeSoftwareText(item.version), publisher: sanitizeSoftwareText(item.publisher), install_location: sanitizeSoftwareText(item.install_location), product_code: sanitizeSoftwareText(item.product_code) };
    const identity = softwareIdentity(cleanItem.name, cleanItem.publisher, cleanItem.architecture);
    const normalizedName = normalizeSoftwareText(cleanItem.name);
    const current = unique.get(identity);
    if (!current || (!current.version && cleanItem.version)) unique.set(identity, { ...cleanItem, identity, normalizedName });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deviceResult = await client.query<{ software_inventory_initialized_at: Date | null }>(
      "SELECT software_inventory_initialized_at FROM nexora_devices WHERE id=$1 FOR UPDATE", [deviceId]);
    if (!deviceResult.rowCount) throw new Error("Device not found during software reconciliation");
    const baseline = deviceResult.rows[0]!.software_inventory_initialized_at === null;
    const existingResult = await client.query<{
      software_identity: string; name: string; version: string | null; publisher: string | null; is_present: boolean;
    }>("SELECT software_identity,name,version,publisher,is_present FROM nexora_device_software WHERE device_id=$1", [deviceId]);
    const existing = new Map(existingResult.rows.map(row => [row.software_identity, row]));
    let installed = 0;
    let removed = 0;
    let versionChanged = 0;

    for (const item of unique.values()) {
      const previous = existing.get(item.identity);
      const change = !baseline && (!previous || !previous.is_present)
        ? "INSTALLED"
        : !baseline && previous && previous.version !== (item.version ?? null) ? "VERSION_CHANGED" : null;
      await client.query(`INSERT INTO nexora_device_software
        (device_id,software_identity,normalized_name,name,version,publisher,architecture,install_date,install_location,product_code,source,system_component,uninstall_available,first_seen_at,last_seen_at,is_present,removed_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,true,null,$14)
        ON CONFLICT (device_id,software_identity) DO UPDATE SET normalized_name=excluded.normalized_name,name=excluded.name,version=excluded.version,
        publisher=excluded.publisher,architecture=excluded.architecture,install_date=excluded.install_date,install_location=excluded.install_location,
        product_code=excluded.product_code,source=excluded.source,system_component=excluded.system_component,uninstall_available=excluded.uninstall_available,
        last_seen_at=excluded.last_seen_at,is_present=true,removed_at=null,updated_at=excluded.updated_at`,
        [deviceId, item.identity, item.normalizedName, item.name, item.version ?? null, item.publisher ?? null, item.architecture,
          item.install_date ? new Date(item.install_date) : null, item.install_location ?? null, item.product_code ?? null,
          item.source, item.system_component, item.uninstall_available, observedAt]);
      if (change) {
        await client.query(`INSERT INTO nexora_software_changes
          (device_id,software_identity,change_type,name,publisher,previous_version,current_version,observed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [deviceId, item.identity, change, item.name, item.publisher ?? null, previous?.version ?? null, item.version ?? null, observedAt]);
        if (change === "INSTALLED") installed++; else versionChanged++;
      }
    }

    if (!baseline) {
      for (const previous of existing.values()) {
        if (!previous.is_present || unique.has(previous.software_identity)) continue;
        await client.query("UPDATE nexora_device_software SET is_present=false,removed_at=$3,updated_at=$3 WHERE device_id=$1 AND software_identity=$2 AND is_present=true", [deviceId, previous.software_identity, observedAt]);
        await client.query(`INSERT INTO nexora_software_changes
          (device_id,software_identity,change_type,name,publisher,previous_version,current_version,observed_at)
          VALUES ($1,$2,'REMOVED',$3,$4,$5,null,$6)`, [deviceId, previous.software_identity, previous.name, previous.publisher, previous.version, observedAt]);
        removed++;
      }
    } else {
      await client.query("UPDATE nexora_devices SET software_inventory_initialized_at=$2 WHERE id=$1", [deviceId, observedAt]);
    }
    if (installed + removed + versionChanged > 0) {
      await client.query("INSERT INTO nexora_activity(device_id,event,timestamp) VALUES ($1,$2,$3)", [deviceId, `SOFTWARE_CHANGES installed=${installed} removed=${removed} version_changed=${versionChanged}`, observedAt]);
    }
    await client.query("COMMIT");
    return { skipped: false, present: unique.size, installed, removed, versionChanged, baseline };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupSoftwareChanges(now = new Date()) {
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const result = await pool.query("DELETE FROM nexora_software_changes WHERE observed_at < $1", [cutoff]);
  return result.rowCount ?? 0;
}
