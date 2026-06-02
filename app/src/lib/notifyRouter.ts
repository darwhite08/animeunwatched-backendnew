import crypto from "node:crypto"
import { prisma } from "../config/prisma"
import { readSecret } from "./vault"
import { sendMail } from "./mailer"
import { getIo } from "../realtime/io-instance"

/**
 * Central outbound notification dispatcher (admin-side, separate from the
 * user-facing notify lib).
 *
 *   dispatchAdminEvent("alert.critical.backup_missing", "critical", { ... })
 *
 * Walks all active NotificationRules; a rule matches when:
 *   - rule.eventPattern === event, OR
 *   - rule.eventPattern is a prefix.*  (e.g. "alert.critical.*")
 *   AND severity meets rule.minSeverity (info < warning < critical).
 *
 * For each matched rule, fans the payload out to every linked
 * NotificationChannel via the channel's vendor shape:
 *   - email     — config.to[]                              → SMTP via lib/mailer
 *   - slack     — config.webhookSecretName                 → Vault → POST JSON
 *   - webhook   — config.url + optional config.secretName  → HMAC-SHA-256 POST
 *   - push      — config.userIds[]                         → socket emit to user:<id>
 *
 * Failures bump lastDeliveryStatus/failCount; never throws, so a dead
 * vendor can't block the calling code.
 */

const SEV_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 }

export type AdminSeverity = "info" | "warning" | "critical"

export async function dispatchAdminEvent(event: string, severity: AdminSeverity, payload: Record<string, unknown>): Promise<{ matched: number; delivered: number; failed: number }> {
  const rules = await prisma.notificationRule.findMany({
    where: { active: true },
    include: { channels: { include: { channel: true } } },
  }).catch(() => [])
  let matched = 0, delivered = 0, failed = 0

  const matches = rules.filter(r => {
    if (SEV_RANK[severity] < (SEV_RANK[r.minSeverity] ?? 0)) return false
    if (r.eventPattern === event) return true
    if (r.eventPattern.endsWith(".*")) return event.startsWith(r.eventPattern.slice(0, -2))
    return false
  })

  for (const rule of matches) {
    matched++
    for (const link of rule.channels) {
      const ch = link.channel
      if (!ch.active) continue
      try {
        await deliver(ch, event, severity, payload)
        await prisma.notificationChannel.update({
          where: { id: ch.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: "ok", failCount: 0 },
        }).catch(() => undefined)
        delivered++
      } catch (err) {
        failed++
        console.error(`[notifyRouter] ${ch.kind} channel "${ch.name}" failed:`, (err as Error).message)
        await prisma.notificationChannel.update({
          where: { id: ch.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: "fail", failCount: { increment: 1 } },
        }).catch(() => undefined)
      }
    }
  }
  return { matched, delivered, failed }
}

async function deliver(channel: { kind: string; configJson: unknown; name: string }, event: string, severity: string, payload: Record<string, unknown>): Promise<void> {
  const config = (channel.configJson ?? {}) as Record<string, unknown>
  const summary = `[${severity.toUpperCase()}] ${event}`
  switch (channel.kind) {
    case "email": {
      const to = Array.isArray(config.to) ? (config.to as string[]) : []
      if (to.length === 0) throw new Error("email channel missing config.to[]")
      await sendMail({
        to:      to.join(","),
        subject: summary,
        text:    `${summary}\n\n${JSON.stringify(payload, null, 2)}`,
      })
      return
    }
    case "slack": {
      const secretName = typeof config.webhookSecretName === "string" ? config.webhookSecretName : null
      if (!secretName) throw new Error("slack channel missing config.webhookSecretName")
      const webhook = await readSecret(secretName)
      if (!webhook) throw new Error(`vault secret "${secretName}" not found`)
      const r = await fetch(webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: summary + "\n```" + JSON.stringify(payload, null, 2).slice(0, 2000) + "```" }),
      })
      if (!r.ok) throw new Error(`slack returned ${r.status}`)
      return
    }
    case "webhook": {
      const url        = typeof config.url        === "string" ? config.url        : null
      const secretName = typeof config.secretName === "string" ? config.secretName : null
      if (!url) throw new Error("webhook channel missing config.url")
      const body = JSON.stringify({ event, severity, payload, deliveredAt: new Date().toISOString() })
      const headers: Record<string, string> = {
        "Content-Type":      "application/json",
        "X-Kaiveron-Event":  event,
      }
      if (secretName) {
        const secret = await readSecret(secretName)
        if (secret) headers["X-Kaiveron-Signature"] = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
      }
      const r = await fetch(url, { method: "POST", headers, body })
      if (!r.ok) throw new Error(`webhook returned ${r.status}`)
      return
    }
    case "push": {
      const io = getIo()
      if (!io) throw new Error("socket.io not initialized")
      const userIds = Array.isArray(config.userIds) ? (config.userIds as string[]) : []
      for (const uid of userIds) {
        io.to(`user:${uid}`).emit("admin.notification", { event, severity, payload })
      }
      return
    }
    default:
      throw new Error(`unknown channel kind: ${channel.kind}`)
  }
}
