import type { Request } from "express"
import { prisma } from "../config/prisma"

export type SecurityEventType =
  // ── Auth / session
  | "login_success"
  | "login_failed"
  | "register"
  | "password_changed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "account_deleted"
  | "session_revoked"
  | "logout_all"
  | "oauth_login"
  | "oauth_handoff"
  // ── User-initiated content destruction
  | "post_deleted"
  | "comment_deleted"
  | "thread_deleted"
  | "review_deleted"
  | "blog_deleted"
  | "club_deleted"
  // ── Role / permission changes
  | "role_changed"
  | "club_role_changed"
  // ── Moderation actions (modId is in userId; target is in metadata)
  | "mod_action_applied"
  | "report_resolved"
  // ── Suspicious / rate-limited
  | "rate_limit_tripped"
  | "csrf_failure"

/**
 * Record a security-relevant event. Fire-and-forget — never blocks the
 * primary request. Failure to log is logged to stderr but does not throw.
 *
 * The audit log is append-only and never exposed to non-admin users.
 * Useful for: anomaly detection, GDPR data requests, incident forensics.
 *
 * When recording destruction or moderation events, prefer the typed
 * convenience helpers below (`auditDelete`, `auditMod`) so the metadata
 * shape stays consistent across services.
 */
export function recordSecurityEvent(
  type: SecurityEventType,
  opts: {
    userId?: string | null
    req?: Request
    metadata?: Record<string, unknown>
  } = {},
): void {
  const ipAddress = opts.req
    ? (opts.req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
      opts.req.ip ??
      null
    : null
  const userAgent = opts.req?.headers["user-agent"] ?? null

  // Defensive: in unit tests the prisma client is mocked and
  // `securityEvent` may not exist. Skip the write silently in that case.
  const model = prisma?.securityEvent
  if (!model || typeof model.create !== "function") return

  void model.create({
    data: {
      type,
      userId:    opts.userId ?? null,
      ipAddress: ipAddress ?? null,
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 500) : null,
      metadata:  opts.metadata as never,
    },
  }).catch((err: unknown) => {
    // Audit log failure must never break the user flow
    console.error("[audit] failed to record event:", type, err)
  })
}

/**
 * Convenience wrapper for content-destruction events. Standardizes the
 * metadata shape so the audit log can be queried like:
 *
 *   SELECT * FROM "SecurityEvent"
 *   WHERE type LIKE '%_deleted'
 *     AND metadata->>'targetType' = 'Post'
 *     AND metadata->>'targetId'   = $1
 */
export function auditDelete(
  type: Extract<SecurityEventType,
    | "post_deleted" | "comment_deleted" | "thread_deleted"
    | "review_deleted" | "blog_deleted" | "club_deleted"
    | "account_deleted"
  >,
  opts: {
    actorId: string | null
    targetType: "Post" | "PostComment" | "Thread" | "Review" | "Blog" | "Club" | "User"
    targetId: string
    req?: Request
    extra?: Record<string, unknown>
  },
): void {
  recordSecurityEvent(type, {
    userId: opts.actorId,
    req:    opts.req,
    metadata: {
      targetType: opts.targetType,
      targetId:   opts.targetId,
      ...opts.extra,
    },
  })
}

/**
 * Wrapper for moderation + role-change events. The acting moderator is
 * `actorId`; the affected user/object is in metadata.
 */
export function auditMod(
  type: Extract<SecurityEventType,
    | "mod_action_applied" | "report_resolved"
    | "role_changed" | "club_role_changed"
  >,
  opts: {
    actorId: string
    targetUserId?: string
    targetType?: string
    targetId?: string
    action: string
    note?: string | null
    req?: Request
    extra?: Record<string, unknown>
  },
): void {
  recordSecurityEvent(type, {
    userId: opts.actorId,
    req:    opts.req,
    metadata: {
      targetUserId: opts.targetUserId,
      targetType:   opts.targetType,
      targetId:     opts.targetId,
      action:       opts.action,
      note:         opts.note ?? null,
      ...opts.extra,
    },
  })
}
