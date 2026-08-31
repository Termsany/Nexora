import { pool } from "@workspace/db";
import { deliver } from "./adapters/index.ts";
import { DeliveryError, sanitizedError } from "./errors.ts";
import { PROCESSING_LEASE_MS, retryAt, TERMINAL_RETENTION_DAYS } from "./policy.ts";
import type { NotificationChannel, NotificationPayload } from "./types.ts";

export type ClaimedNotification = { id: string; channel: NotificationChannel; payload: NotificationPayload; attempt_count: number; max_attempts: number };

export async function claimNotification(now = new Date()): Promise<ClaimedNotification | null> {
  const result = await pool.query<ClaimedNotification>(`WITH candidate AS (
    SELECT id FROM nexora_notifications
    WHERE ((state IN ('PENDING','RETRY') AND next_attempt_at <= $1) OR (state = 'PROCESSING' AND lease_until < $1))
    ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE nexora_notifications n SET state='PROCESSING', attempt_count=n.attempt_count+1,
    last_attempt_at=$1, lease_until=$2, updated_at=$1 FROM candidate WHERE n.id=candidate.id
  RETURNING n.id,n.channel,n.payload,n.attempt_count,n.max_attempts`, [now, new Date(now.getTime() + PROCESSING_LEASE_MS)]);
  return result.rows[0] ?? null;
}

export async function processNotification(notification: ClaimedNotification, now = new Date(), sender = deliver) {
  const started = Date.now();
  try {
    await sender(notification.channel, notification.id, notification.payload);
    await pool.query(`UPDATE nexora_notifications SET state='SENT',sent_at=$2,lease_until=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=$2 WHERE id=$1 AND state='PROCESSING'`, [notification.id, now]);
    return { state: "SENT" as const, durationMs: Date.now() - started };
  } catch (reason) {
    const error = reason instanceof DeliveryError ? reason : sanitizedError(reason);
    const failed = !error.retryable || notification.attempt_count >= notification.max_attempts;
    const next = failed ? now : retryAt(notification.attempt_count, now, error.retryAfterSeconds);
    await pool.query(`UPDATE nexora_notifications SET state=$2,failed_at=$3,next_attempt_at=$4,lease_until=NULL,last_error_code=$5,last_error_message=$6,updated_at=$7 WHERE id=$1 AND state='PROCESSING'`, [notification.id, failed ? "FAILED" : "RETRY", failed ? now : null, next, error.code, error.message.slice(0, 500), now]);
    return { state: failed ? "FAILED" as const : "RETRY" as const, code: error.code, durationMs: Date.now() - started, nextAttemptAt: failed ? null : next };
  }
}

export async function cleanupNotifications(now = new Date()) {
  const cutoff = new Date(now.getTime() - TERMINAL_RETENTION_DAYS * 86_400_000);
  const result = await pool.query(`DELETE FROM nexora_notifications WHERE state IN ('SENT','FAILED','CANCELLED') AND updated_at < $1`, [cutoff]);
  return result.rowCount ?? 0;
}

export async function heartbeat(now = new Date(), metadata?: Record<string, unknown>) {
  await pool.query(`INSERT INTO nexora_worker_heartbeats(worker,last_seen_at,metadata) VALUES ('notification-worker',$1,$2)
    ON CONFLICT (worker) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,metadata=EXCLUDED.metadata`, [now, metadata ?? {}]);
}
