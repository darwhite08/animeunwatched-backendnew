import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * Fires outbound HMAC-SHA-256 signed webhooks to every active TicketWebhook
 * whose `events` array matches the supplied event. Headers:
 *   X-Kaiveron-Event:     ticket.created
 *   X-Kaiveron-Signature: sha256=<hex>     (computed over the raw request body)
 *   X-Kaiveron-Delivery:  <random UUID>
 *
 * Best-effort: failures bump TicketWebhook.failCount and log; we don't
 * retry here (the existing webhook dispatcher handles WebhookDelivery rows
 * already; this is a simpler one-shot path so the user-facing tickets
 * surface stays cheap).
 */

export type TicketEvent = "ticket.created" | "ticket.replied" | "ticket.status_changed"

const TIMEOUT_MS = 5_000

export async function fireTicketEvent(event: TicketEvent, payload: Record<string, unknown>): Promise<void> {
  const hooks = await prisma.ticketWebhook.findMany({ where: { active: true } }).catch(() => [])
  if (hooks.length === 0) return
  const body = JSON.stringify({ event, payload, deliveredAt: new Date().toISOString() })

  await Promise.all(hooks.map(async (h) => {
    if (h.events.length > 0 && !h.events.includes("*") && !h.events.includes(event)) return
    const sig = crypto.createHmac("sha256", h.secret).update(body).digest("hex")
    const deliveryId = crypto.randomUUID()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const r = await fetch(h.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type":          "application/json",
          "X-Kaiveron-Event":      event,
          "X-Kaiveron-Signature":  `sha256=${sig}`,
          "X-Kaiveron-Delivery":   deliveryId,
        },
        body,
      })
      clearTimeout(timer)
      await prisma.ticketWebhook.update({
        where: { id: h.id },
        data: {
          lastDeliveryAt: new Date(),
          lastDeliveryStatus: r.ok ? "ok" : "fail",
          failCount: r.ok ? 0 : { increment: 1 },
        },
      }).catch(() => undefined)
    } catch (err) {
      await prisma.ticketWebhook.update({
        where: { id: h.id },
        data: {
          lastDeliveryAt: new Date(),
          lastDeliveryStatus: "fail",
          failCount: { increment: 1 },
        },
      }).catch(() => undefined)
      console.error(`[ticket-webhook] delivery to ${h.url} failed:`, (err as Error).message)
    }
  }))
}
