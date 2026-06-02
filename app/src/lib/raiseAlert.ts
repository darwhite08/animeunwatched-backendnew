import { prisma } from "../config/prisma"
import { dispatchAdminEvent, type AdminSeverity } from "./notifyRouter"

/**
 * One-stop helper to (a) persist an AdminAlert row + (b) fan it out
 * through the NotificationRouter. Existing prisma.adminAlert.create()
 * call sites should switch to this so a single change-point governs
 * how alerts reach humans.
 *
 * Event name convention: `alert.<severity>.<category>` — so a rule like
 * `alert.critical.*` catches every critical regardless of source.
 */

export interface RaiseAlertInput {
  severity:  AdminSeverity                    // "critical" | "warning" | "info"
  category:  string                           // "uptime" | "backup" | "anomaly" | "audit" | ...
  title:     string
  body?:     string | null
  link?:     string | null
  metadata?: Record<string, unknown>
}

export async function raiseAlert(input: RaiseAlertInput): Promise<void> {
  try {
    await prisma.adminAlert.create({
      data: {
        severity: input.severity,
        category: input.category,
        title:    input.title,
        body:     input.body ?? null,
        link:     input.link ?? null,
        metadata: (input.metadata ?? null) as never,
      },
    })
  } catch (err) {
    console.error("[raiseAlert] persist failed:", err)
  }
  // Best-effort dispatch — the AdminAlert row is the source of truth; the
  // router fan-out is the "tell humans" side. Don't surface dispatch errors.
  try {
    await dispatchAdminEvent(`alert.${input.severity}.${input.category}`, input.severity, {
      title:    input.title,
      body:     input.body ?? null,
      link:     input.link ?? null,
      metadata: input.metadata ?? null,
    })
  } catch (err) {
    console.error("[raiseAlert] dispatch failed:", err)
  }
}
