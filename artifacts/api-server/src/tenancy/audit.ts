import type { Request } from "express";
import { auditLogTable, db } from "@workspace/db";
import type { TenantContext } from "./context.ts";

export type AuditAction =
  | "ORGANIZATION_CREATED"
  | "ORGANIZATION_UPDATED"
  | "ORGANIZATION_SUSPENDED"
  | "ORGANIZATION_ARCHIVED"
  | "ORGANIZATION_REACTIVATED"
  | "SITE_CREATED"
  | "SITE_UPDATED"
  | "SITE_ARCHIVED"
  | "MEMBERSHIP_CREATED"
  | "MEMBERSHIP_UPDATED"
  | "MEMBERSHIP_REMOVED"
  | "ENROLLMENT_TOKEN_CREATED"
  | "ENROLLMENT_TOKEN_REVOKED"
  | "DEVICE_SITE_CHANGED"
  | "AGENT_ENROLLED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_SUSPENDED"
  | "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGIN_RATE_LIMITED" | "LOGOUT" | "SESSION_REVOKED"
  | "ALERT_ACKNOWLEDGED"
  | "PRIVILEGED_ACTION_REQUESTED" | "PRIVILEGED_ACTION_APPROVED" | "PRIVILEGED_ACTION_REJECTED" | "PRIVILEGED_ACTION_CANCELLED"
  | "REMOTE_COMMAND_REQUESTED" | "REMOTE_COMMAND_READY" | "REMOTE_COMMAND_CLAIMED" | "REMOTE_COMMAND_STARTED" | "REMOTE_COMMAND_SUCCEEDED" | "REMOTE_COMMAND_FAILED" | "REMOTE_COMMAND_TIMED_OUT" | "REMOTE_COMMAND_CANCEL_REQUESTED" | "REMOTE_COMMAND_CANCELLED" | "REMOTE_COMMAND_EXPIRED" | "REMOTE_COMMAND_UNKNOWN" | "REMOTE_COMMAND_RESULT_CONFLICT" | "REMOTE_COMMAND_REPLAY_REJECTED";
  

/**
 * Records a security-relevant action.
 *
 * `metadata` must contain only descriptive values. Raw enrollment tokens, agent
 * credentials, session tokens, password hashes, the administrative API token
 * and any other secret are never passed in — the audit trail is read by more
 * people than the secrets themselves ever should be.
 */
export async function recordAudit(entry: {
  action: AuditAction;
  context?: TenantContext | null;
  actorLabel?: string | null;
  organizationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
  result?: "SUCCESS" | "DENIED" | "FAILURE";
  req?: Request;
}) {
  const actorLabel = entry.actorLabel
    ?? (entry.context?.principal.kind === "platform-api" ? "administrative-api" : null);
  await db.insert(auditLogTable).values({
    action: entry.action,
    subjectId: entry.subjectId ?? entry.targetId ?? null,
    actorUserId: entry.context?.userId ?? null,
    actorLabel,
    organizationId: entry.organizationId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ipAddress: entry.req?.ip ?? null,
    actorType: entry.context?.principal.kind === "user" ? "USER" : entry.context?.principal.kind === "platform-api" ? "PLATFORM_API" : "ANONYMOUS",
    result: entry.result ?? "SUCCESS",
    userAgent: entry.req?.headers["user-agent"]?.slice(0, 500) ?? null,
    requestId: entry.req?.requestId ?? null,
    metadata: entry.metadata ?? null,
  });
}

/** Human-readable actor for alert acknowledgement and similar operational records. */
export function actorName(context: TenantContext): string {
  if (context.principal.kind === "platform-api") return "administrative-api";
  return context.principal.user.email;
}
