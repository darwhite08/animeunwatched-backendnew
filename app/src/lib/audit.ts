import type { Request } from "express"
import { prisma } from "../config/prisma"

export type SecurityEventType =
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

/**
 * Record a security-relevant event. Fire-and-forget — never blocks the
 * primary request. Failure to log is logged to stderr but does not throw.
 *
 * The audit log is append-only and never exposed to non-admin users.
 * Useful for: anomaly detection, GDPR data requests, incident forensics.
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

  void prisma.securityEvent.create({
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
