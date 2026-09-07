// Task #010W Phase 4 — production-like preservation fixture.
//
// Seeds a representative pre-Task010 dataset (migrated only through 0009)
// covering every table category the mission lists, then snapshots row counts
// and key identity fields to /tmp/preservation-before.json for
// task010-preservation-verify.mjs to compare against after 0010-0012 apply.
import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * (1 << 15) * 8 * 2 });
  return `scrypt$15$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ids = {
  org: crypto.randomUUID(), site: crypto.randomUUID(), device: crypto.randomUUID(), deviceUuid: crypto.randomUUID(),
  user: crypto.randomUUID(), alert: crypto.randomUUID(), enrollmentToken: crypto.randomUUID(),
};
const PASSWORD = "preservation-fixture-password-0000";
const AGENT_TOKEN = "PRESERVATION-FIXTURE-AGENT-BEARER-TOKEN";
const AGENT_ID = "PRESERVATION-FIXTURE-AGENT-001";
const now = new Date();

async function main() {
  await pool.query("INSERT INTO nexora_organizations(id,name,slug) VALUES ($1,$2,$3)", [ids.org, "Preservation Fixture Org", `preservation-${ids.org}`]);
  await pool.query("INSERT INTO nexora_sites(id,organization_id,name) VALUES ($1,$2,$3)", [ids.site, ids.org, "Preservation Site"]);

  const passwordHash = await hashPassword(PASSWORD);
  await pool.query("INSERT INTO nexora_users(id,email,name,password_hash,scope,platform_role) VALUES ($1,$2,'Preservation User',$3,'ORGANIZATION',NULL)", [ids.user, `preservation-${ids.user}@test.invalid`, passwordHash]);
  await pool.query("INSERT INTO nexora_organization_memberships(user_id,organization_id,role) VALUES ($1,$2,'ORGANIZATION_ADMIN')", [ids.user, ids.org]);
  await pool.query("INSERT INTO nexora_sessions(user_id,token_hash,expires_at,ip_address,user_agent) VALUES ($1,$2,now() + interval '1 hour','203.0.113.1','preservation-fixture-agent')", [ids.user, crypto.createHash("sha256").update("preservation-fixture-session-token").digest("hex")]);

  await pool.query(
    "INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,organization_id,site_id,last_seen_at,status,os_name,agent_version) VALUES ($1,$2,$3,'PRESERVATION-HOST',$4,$5,$6,'ONLINE','Windows 11 Pro','1.0.0-fixture')",
    [ids.device, AGENT_ID, ids.deviceUuid, ids.org, ids.site, now],
  );
  const agentTokenHash = crypto.createHash("sha256").update(AGENT_TOKEN).digest("hex");
  await pool.query("INSERT INTO nexora_agent_credentials(device_id,token_hash) VALUES ($1,$2)", [ids.device, agentTokenHash]);

  const metricRow = await pool.query(
    "INSERT INTO nexora_device_metrics(device_id,captured_at,received_at,cpu_percent,ram_percent,ram_used_bytes,ram_available_bytes,disk_percent,uptime_seconds) VALUES ($1,$2,$2,23,55,1000000,2000000,40,7200) RETURNING id",
    [ids.device, now],
  );
  await pool.query(
    "INSERT INTO nexora_disk_metrics(device_id,metric_id,volume,filesystem,total_bytes,used_bytes,free_bytes,used_percent,captured_at) VALUES ($1,$2,'C:','NTFS',500000000000,200000000000,300000000000,40,$3)",
    [ids.device, metricRow.rows[0].id, now],
  );
  await pool.query("INSERT INTO nexora_activity(device_id,event) VALUES ($1,'AGENT_ENROLLED')", [ids.device]);

  await pool.query(
    "INSERT INTO nexora_alerts(id,organization_id,device_id,type,severity,state,title,summary,dedup_key) VALUES ($1,$2,$3,'CPU_HIGH','warning','OPEN','Preservation CPU high','fixture alert',$4)",
    [ids.alert, ids.org, ids.device, `preservation-fixture-${ids.alert}`],
  );
  await pool.query("INSERT INTO nexora_alert_events(alert_id,event_type,new_state) VALUES ($1,'CREATED','OPEN')", [ids.alert]);

  const notifId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO nexora_notifications(id,organization_id,alert_id,channel,destination,event_type,severity,state,dedup_key,payload) VALUES ($1,$2,$3,'email','ops@preservation-fixture.test','ALERT_CREATED','warning','SENT',$4,$5)",
    [notifId, ids.org, ids.alert, `preservation-fixture-notif-${notifId}`, JSON.stringify({ title: "fixture" })],
  );

  const identity = crypto.createHash("sha256").update("preservation fixture suite").digest("hex");
  await pool.query(
    "INSERT INTO nexora_device_software(device_id,software_identity,normalized_name,name,version,publisher,architecture) VALUES ($1,$2,'preservation fixture suite','Preservation Fixture Suite','1.0','Fixture Publisher','x64')",
    [ids.device, identity],
  );
  await pool.query(
    "INSERT INTO nexora_device_services(device_id,service_name,display_name,status,startup_type,first_seen_at,last_seen_at) VALUES ($1,'FixtureSvc','Fixture Service','RUNNING','AUTOMATIC',$2,$2)",
    [ids.device, now],
  );
  await pool.query(
    "INSERT INTO nexora_device_processes_current(device_id,pid,process_name,executable_path,username,cpu_time_seconds,working_set_bytes,started_at,architecture,snapshot_id,last_seen_at) VALUES ($1,4242,'fixture.exe','C:/fixture.exe','FIXTURE\\\\svc',12.5,50000000,$2,'x64',$3,$2)",
    [ids.device, now, crypto.randomUUID()],
  );

  await pool.query(
    "INSERT INTO nexora_enrollment_tokens(id,name,organization_id,token_hash,expires_at,created_by_user_id) VALUES ($1,'Preservation Fixture Token',$2,$3,now() + interval '30 days',$4)",
    [ids.enrollmentToken, ids.org, crypto.createHash("sha256").update("preservation-fixture-enrollment-secret").digest("hex"), ids.user],
  );

  await pool.query(
    "INSERT INTO nexora_audit_log(action,actor_type,actor_user_id,organization_id,target_type,target_id,result) VALUES ('LOGIN_SUCCESS','USER',$1,$2,'user',$3,'SUCCESS')",
    [ids.user, ids.org, ids.user],
  );

  // Snapshot: row counts for every touched table, plus key identity fields.
  const tables = [
    "nexora_organizations", "nexora_sites", "nexora_users", "nexora_organization_memberships", "nexora_sessions",
    "nexora_devices", "nexora_agent_credentials", "nexora_device_metrics", "nexora_disk_metrics", "nexora_activity",
    "nexora_alerts", "nexora_alert_events", "nexora_notifications", "nexora_device_software", "nexora_device_services",
    "nexora_device_processes_current", "nexora_enrollment_tokens", "nexora_audit_log",
  ];
  const counts = {};
  for (const table of tables) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = r.rows[0].n;
  }

  const deviceRow = (await pool.query("SELECT agent_id, device_uuid, organization_id, site_id, hostname FROM nexora_devices WHERE id=$1", [ids.device])).rows[0];
  const credentialRow = (await pool.query("SELECT token_hash FROM nexora_agent_credentials WHERE device_id=$1", [ids.device])).rows[0];
  const membershipRow = (await pool.query("SELECT organization_id, role FROM nexora_organization_memberships WHERE user_id=$1", [ids.user])).rows[0];

  const snapshot = {
    ids, counts,
    device: deviceRow,
    credential: credentialRow,
    membership: membershipRow,
    agentTokenHash,
  };
  process.stdout.write(JSON.stringify(snapshot));
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
