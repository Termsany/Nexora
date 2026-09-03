import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { evaluateAlerts } from "../alerts/engine.ts";
import { DeliveryError } from "./errors.ts";
import { claimNotification, processNotification } from "./worker.ts";

const deviceId = "55555555-5555-4555-8555-555555555555";
const now = new Date();
const claimNow = new Date(now.getTime() + 10_000);
try {
  await pool.query(`INSERT INTO nexora_devices(id,agent_id,device_uuid,hostname,status,organization,last_seen_at)
    VALUES ($1,'notification-fixture','66666666-6666-4666-8666-666666666666','notification-fixture','ONLINE','Fixture Org',$2)`, [deviceId, new Date(now.getTime() - 180_000)]);
  const first = await evaluateAlerts(now); assert.equal(first.alertsCreated, 1);
  const second = await evaluateAlerts(new Date(now.getTime() + 1_000)); assert.equal(second.alertsCreated, 0); assert.equal(second.alertsUpdated, 1);
  let result = await pool.query(`SELECT n.*,a.device_id FROM nexora_notifications n JOIN nexora_alerts a ON a.id=n.alert_id ORDER BY n.created_at`);
  assert.equal(result.rowCount, 1); assert.equal(result.rows[0].event_type, "ALERT_CREATED"); assert.equal(result.rows[0].organization, "Fixture Org"); assert.equal(result.rows[0].device_id, deviceId);

  const claims = await Promise.all([claimNotification(claimNow), claimNotification(claimNow)]); assert.equal(claims.filter(Boolean).length, 1);
  const sent = await processNotification(claims.find(Boolean), claimNow, async () => {}); assert.equal(sent.state, "SENT");
  result = await pool.query(`SELECT state,attempt_count FROM nexora_notifications WHERE event_type='ALERT_CREATED'`); assert.deepEqual(result.rows[0], { state: "SENT", attempt_count: 1 });

  await pool.query(`INSERT INTO nexora_notifications(channel,destination,event_type,state,max_attempts,dedup_key,payload,next_attempt_at) VALUES ('telegram','fixture','TEST','PENDING',2,'retry-fixture','{"event":"TEST","timestamp":"2026-01-01T00:00:00Z","test":{"server":"fixture"}}',$1)`, [now]);
  let retry = await claimNotification(claimNow); assert.ok(retry); let outcome = await processNotification(retry, claimNow, async () => { throw new DeliveryError("TELEGRAM_HTTP_500", "Telegram service unavailable", true); }); assert.equal(outcome.state, "RETRY");
  await pool.query(`UPDATE nexora_notifications SET next_attempt_at=$1 WHERE dedup_key='retry-fixture'`, [claimNow]); retry = await claimNotification(claimNow); assert.ok(retry); outcome = await processNotification(retry, claimNow, async () => { throw new DeliveryError("TELEGRAM_HTTP_500", "Telegram service unavailable", true); }); assert.equal(outcome.state, "FAILED");

  await pool.query(`INSERT INTO nexora_notifications(channel,destination,event_type,state,dedup_key,payload,next_attempt_at,lease_until) VALUES ('telegram','fixture','TEST','PROCESSING','lease-fixture','{"event":"TEST","timestamp":"2026-01-01T00:00:00Z","test":{"server":"fixture"}}',$1,$2)`, [now, new Date(now.getTime() - 1)]);
  const recovered = await claimNotification(claimNow); assert.equal(recovered?.attempt_count, 1); await processNotification(recovered, claimNow, async () => {});

  await pool.query(`UPDATE nexora_devices SET last_seen_at=$2 WHERE id=$1`, [deviceId, now]);
  const resolution = await evaluateAlerts(new Date(now.getTime() + 2_000)); assert.equal(resolution.alertsResolved, 1);
  result = await pool.query(`SELECT count(*)::int total FROM nexora_notifications WHERE event_type='ALERT_RESOLVED'`); assert.equal(result.rows[0].total, 1);
  result = await pool.query(`SELECT count(*)::int total FROM nexora_notifications WHERE event_type='ALERT_ACKNOWLEDGED'`); assert.equal(result.rows[0].total, 0);
  console.log(JSON.stringify({ transactional_outbox: "PASS", deduplication: "PASS", claim_once: "PASS", retry_and_max_attempts: "PASS", stale_lease: "PASS", resolved_intent: "PASS" }));
} finally { await pool.end(); }
