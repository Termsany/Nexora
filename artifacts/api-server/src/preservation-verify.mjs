// Task #010W Phase 4 — production-like preservation verification.
//
// Reads the before-snapshot written by task010-preservation-seed.mjs, then
// re-queries the same rows and tables after migrations 0010-0012 have been
// applied on top, asserting every preservation invariant the mission lists.
import pg from "pg";

const before = JSON.parse(process.env.PRESERVATION_SNAPSHOT);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const results = [];
  const check = (name, condition, detail) => { results.push({ name, pass: Boolean(condition), detail }); };

  for (const [table, expected] of Object.entries(before.counts)) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    check(`${table} row count unchanged (${expected})`, r.rows[0].n === expected, `expected ${expected}, got ${r.rows[0].n}`);
  }

  const deviceRow = (await pool.query("SELECT agent_id, device_uuid, organization_id, site_id, hostname, remote_commands_enabled, capabilities FROM nexora_devices WHERE id=$1", [before.ids.device])).rows[0];
  check("device UUID unchanged", deviceRow.device_uuid === before.device.device_uuid, `${deviceRow.device_uuid} vs ${before.device.device_uuid}`);
  check("Agent identity (agent_id) unchanged", deviceRow.agent_id === before.device.agent_id);
  check("device organization/site relationship unchanged", deviceRow.organization_id === before.device.organization_id && deviceRow.site_id === before.device.site_id);
  check("device hostname unchanged", deviceRow.hostname === before.device.hostname);
  check("new remote_commands_enabled column initialized safely (false, not null)", deviceRow.remote_commands_enabled === false, deviceRow.remote_commands_enabled);
  check("new capabilities column initialized safely (empty array, not null)", Array.isArray(deviceRow.capabilities) && deviceRow.capabilities.length === 0, JSON.stringify(deviceRow.capabilities));

  const credentialRow = (await pool.query("SELECT token_hash FROM nexora_agent_credentials WHERE device_id=$1", [before.ids.device])).rows[0];
  check("Agent credential hash unchanged (no forced re-enrollment)", credentialRow.token_hash === before.credential.token_hash);
  check("Agent credential hash matches the original bearer token's hash", credentialRow.token_hash === before.agentTokenHash);

  const membershipRow = (await pool.query("SELECT organization_id, role FROM nexora_organization_memberships WHERE user_id=$1", [before.ids.user])).rows[0];
  check("user/membership relationship unchanged", membershipRow.organization_id === before.membership.organization_id && membershipRow.role === before.membership.role);

  const noNullOrg = await pool.query("SELECT count(*)::int AS n FROM nexora_devices WHERE organization_id IS NULL");
  check("no accidental NULL tenant relationship on any device", noNullOrg.rows[0].n === 0);
  const noNullAlertOrg = await pool.query("SELECT count(*)::int AS n FROM nexora_alerts WHERE organization_id IS NULL");
  check("no accidental NULL tenant relationship on any alert", noNullAlertOrg.rows[0].n === 0);

  const newTables = ["nexora_remote_command_jobs", "nexora_agent_signing_keys", "nexora_agent_request_nonces"];
  for (const table of newTables) {
    const exists = await pool.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${table}`]);
    check(`new Task010 table ${table} exists`, exists.rows[0].exists);
    const count = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    check(`new Task010 table ${table} starts empty (no destructive default data)`, count.rows[0].n === 0);
  }

  const sessionRow = await pool.query("SELECT count(*)::int AS n FROM nexora_sessions WHERE user_id=$1 AND revoked_at IS NULL", [before.ids.user]);
  check("pre-existing session survives migration, unrevoked", sessionRow.rows[0].n === 1);

  const softwareRow = (await pool.query("SELECT name, version FROM nexora_device_software WHERE device_id=$1", [before.ids.device])).rows[0];
  check("software inventory preserved", softwareRow && softwareRow.name === "Preservation Fixture Suite");
  const serviceRow = (await pool.query("SELECT service_name FROM nexora_device_services WHERE device_id=$1", [before.ids.device])).rows[0];
  check("services inventory preserved", serviceRow && serviceRow.service_name === "FixtureSvc");
  const processRow = (await pool.query("SELECT process_name FROM nexora_device_processes_current WHERE device_id=$1", [before.ids.device])).rows[0];
  check("processes inventory preserved", processRow && processRow.process_name === "fixture.exe");
  const alertRow = (await pool.query("SELECT state FROM nexora_alerts WHERE id=$1", [before.ids.alert])).rows[0];
  check("alert preserved", alertRow && alertRow.state === "OPEN");
  const auditRow = await pool.query("SELECT count(*)::int AS n FROM nexora_audit_log WHERE actor_user_id=$1 AND action='LOGIN_SUCCESS'", [before.ids.user]);
  check("audit record preserved", auditRow.rows[0].n === 1);
  const notifRow = await pool.query("SELECT count(*)::int AS n FROM nexora_notifications WHERE organization_id=$1", [before.ids.org]);
  check("notification preserved", notifRow.rows[0].n === 1);
  const metricsRow = await pool.query("SELECT count(*)::int AS n FROM nexora_device_metrics WHERE device_id=$1", [before.ids.device]);
  check("telemetry (metrics) preserved", metricsRow.rows[0].n === 1);
  const diskRow = await pool.query("SELECT count(*)::int AS n FROM nexora_disk_metrics WHERE device_id=$1", [before.ids.device]);
  check("telemetry (disk metrics) preserved", diskRow.rows[0].n === 1);

  await pool.end();

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} - ${r.name}${r.detail !== undefined ? ` (${JSON.stringify(r.detail)})` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} preservation assertions passed`);
  if (failed.length) { process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
