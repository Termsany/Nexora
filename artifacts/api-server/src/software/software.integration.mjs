import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { reconcileSoftwareSnapshot } from "./reconcile.ts";

const firstDevice = "77777777-7777-4777-8777-777777777777";
const otherDevice = "88888888-8888-4888-8888-888888888888";
const scaleDevice = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const app = (index, version = "1.0") => ({ name: index === 0 ? "Google Chrome" : `Fixture App ${index}`, version, publisher: index === 0 ? "Google LLC" : "Fixture Vendor", install_date: null, install_location: null, uninstall_available: true, product_code: null, architecture: index % 2 ? "x86" : "x64", source: "windows_registry", system_component: false });
const snapshot = (entries, complete = true) => ({ complete, collected_at: new Date().toISOString(), entries });

try {
  await pool.query(`INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization) VALUES
    ($1,'software-fixture-a','99999999-9999-4999-8999-999999999999','fixture-a','Org A'),
    ($2,'software-fixture-b','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture-b','Org B'),
    ($3,'software-fixture-scale','cccccccc-cccc-4ccc-8ccc-cccccccccccc','fixture-scale','Org A')`, [firstDevice, otherDevice, scaleDevice]);
  const initial = Array.from({ length: 100 }, (_, index) => app(index));
  const baselineStarted = performance.now();
  let result = await reconcileSoftwareSnapshot(firstDevice, snapshot(initial));
  const baseline100Ms = Math.round((performance.now() - baselineStarted) * 10) / 10;
  assert.deepEqual({ present: result.present, baseline: result.baseline, installed: result.installed }, { present: 100, baseline: true, installed: 0 });
  let query = await pool.query("SELECT count(*)::int total FROM nexora_device_software WHERE device_id=$1 AND is_present", [firstDevice]); assert.equal(query.rows[0].total, 100);
  query = await pool.query("SELECT count(*)::int total FROM nexora_software_changes WHERE device_id=$1", [firstDevice]); assert.equal(query.rows[0].total, 0);

  result = await reconcileSoftwareSnapshot(firstDevice, snapshot(initial)); assert.equal(result.installed + result.removed + result.versionChanged, 0);
  const withNew = [...initial, app(100)]; result = await reconcileSoftwareSnapshot(firstDevice, snapshot(withNew)); assert.equal(result.installed, 1);
  const upgraded = withNew.map((item, index) => index === 0 ? app(0, "2.0") : item); result = await reconcileSoftwareSnapshot(firstDevice, snapshot(upgraded)); assert.equal(result.versionChanged, 1);
  const removed = upgraded.slice(0, 100); result = await reconcileSoftwareSnapshot(firstDevice, snapshot(removed)); assert.equal(result.removed, 1);

  result = await reconcileSoftwareSnapshot(firstDevice, snapshot([], false)); assert.equal(result.skipped, true);
  query = await pool.query("SELECT count(*)::int total FROM nexora_device_software WHERE device_id=$1 AND is_present", [firstDevice]); assert.equal(query.rows[0].total, 100);
  const beforeRetry = await pool.query("SELECT count(*)::int total FROM nexora_software_changes WHERE device_id=$1", [firstDevice]);
  await reconcileSoftwareSnapshot(firstDevice, snapshot(removed));
  const afterRetry = await pool.query("SELECT count(*)::int total FROM nexora_software_changes WHERE device_id=$1", [firstDevice]); assert.equal(afterRetry.rows[0].total, beforeRetry.rows[0].total);

  await reconcileSoftwareSnapshot(otherDevice, snapshot([app(0)]));
  query = await pool.query("SELECT count(*)::int total FROM nexora_device_software WHERE device_id=$1", [otherDevice]); assert.equal(query.rows[0].total, 1);
  query = await pool.query("SELECT count(*)::int total FROM nexora_device_software s JOIN nexora_devices d ON d.id=s.device_id WHERE d.organization='Org A'"); assert.equal(query.rows[0].total, 101);
  const scaleEntries = Array.from({ length: 300 }, (_, index) => app(index)); const scaleSnapshot = snapshot(scaleEntries);
  const scaleStarted = performance.now(); await reconcileSoftwareSnapshot(scaleDevice, scaleSnapshot); const baseline300Ms = Math.round((performance.now() - scaleStarted) * 10) / 10;
  console.log(JSON.stringify({ baseline_100: "PASS", identical: "PASS", installed: "PASS", version_changed: "PASS", removed: "PASS", incomplete_safety: "PASS", retry_idempotency: "PASS", isolation: "PASS", baseline_100_ms: baseline100Ms, baseline_300_ms: baseline300Ms, payload_100_bytes: Buffer.byteLength(JSON.stringify(snapshot(initial))), payload_300_bytes: Buffer.byteLength(JSON.stringify(scaleSnapshot)) }));
} finally { await pool.end(); }
