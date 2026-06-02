import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Admin activity inbox — single endpoint that returns a unified set of
 * items needing attention across the whole console:
 *   - pending approval requests (two-person rule queue)
 *   - sev1/sev2 open incidents
 *   - pending RTBF requests
 *   - unacked critical anomalies
 *   - failing synthetic monitors
 *   - unacked critical AdminAlerts
 *   - failed ticket webhook deliveries
 *
 * Each item shares a normalized shape so the UI can render one timeline.
 * Returns counts + a sorted-by-recency list capped at 100.
 */

interface InboxItem {
  id:         string                  // unique within the response (kind + id)
  kind:       string                  // "approval" | "incident" | "rtbf" | "anomaly" | "monitor" | "alert" | "webhook"
  severity:   "info" | "warning" | "critical"
  title:      string
  body?:      string
  link:       string                  // admin URL
  occurredAt: string
  meta?:      Record<string, unknown>
}

export async function getInbox(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = new Date()
    const last24h = new Date(Date.now() - 24 * 60 * 60_000)
    const last7d  = new Date(Date.now() -  7 * 24 * 60 * 60_000)

    const [approvals, incidents, rtbfs, anomalies, monitors, alerts, badHooks] = await Promise.all([
      prisma.approvalRequest.findMany({ where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.incident.findMany({ where: { status: { not: "resolved" }, severity: { in: ["sev1","sev2"] } }, orderBy: { startedAt: "desc" }, take: 20 }),
      prisma.rtbfRequest.findMany({ where: { status: { in: ["pending","verified"] } }, orderBy: { requestedAt: "desc" }, take: 20 }),
      prisma.anomalyEvent.findMany({ where: { severity: "critical", acknowledgedAt: null, createdAt: { gte: last7d } }, orderBy: { createdAt: "desc" }, take: 25 }),
      prisma.syntheticMonitor.findMany({ where: { enabled: true, lastOutcome: { in: ["fail","timeout"] } }, orderBy: { lastRunAt: "desc" } }),
      prisma.adminAlert.findMany({ where: { acknowledgedAt: null, severity: { in: ["critical","warning"] }, createdAt: { gte: last24h } }, orderBy: { createdAt: "desc" }, take: 25 }),
      prisma.ticketWebhook.findMany({ where: { active: true, lastDeliveryStatus: "fail", failCount: { gt: 2 } } }),
    ])

    const items: InboxItem[] = []
    for (const a of approvals) items.push({
      id: `approval:${a.id}`, kind: "approval", severity: "warning",
      title: `Approval needed: ${a.action}`, body: `Requested by ${a.requestedBy.slice(0,8)}… · ${a.reason}`,
      link: `/approvals`, occurredAt: a.createdAt.toISOString(),
      meta: { resource: a.resource, expiresAt: a.expiresAt },
    })
    for (const i of incidents) items.push({
      id: `incident:${i.id}`, kind: "incident", severity: i.severity === "sev1" ? "critical" : "warning",
      title: `${i.severity.toUpperCase()}: ${i.title}`, body: `Category: ${i.category}`,
      link: `/incidents/${i.id}`, occurredAt: i.startedAt.toISOString(),
      meta: { status: i.status },
    })
    for (const r of rtbfs) items.push({
      id: `rtbf:${r.id}`, kind: "rtbf", severity: "warning",
      title: `RTBF ${r.status}: ${r.email}`, link: `/compliance`,
      occurredAt: r.requestedAt.toISOString(),
      meta: { userId: r.userId },
    })
    for (const a of anomalies) items.push({
      id: `anomaly:${a.id}`, kind: "anomaly", severity: "critical",
      title: `Anomaly: ${a.kind.replace(/_/g, " ")}`, body: a.ipAddress ? `IP ${a.ipAddress}` : undefined,
      link: `/anomalies`, occurredAt: a.createdAt.toISOString(),
      meta: { userId: a.userId },
    })
    for (const m of monitors) items.push({
      id: `monitor:${m.id}`, kind: "monitor", severity: "warning",
      title: `Monitor failing: ${m.name}`, body: m.lastError ?? undefined,
      link: `/observability`, occurredAt: (m.lastRunAt ?? now).toISOString(),
      meta: { lastLatencyMs: m.lastLatencyMs },
    })
    for (const al of alerts) items.push({
      id: `alert:${al.id}`, kind: "alert", severity: al.severity === "critical" ? "critical" : "warning",
      title: al.title, body: al.body ?? undefined,
      link: al.link ?? "/alerts", occurredAt: al.createdAt.toISOString(),
      meta: { category: al.category },
    })
    for (const h of badHooks) items.push({
      id: `webhook:${h.id}`, kind: "webhook", severity: "warning",
      title: `Webhook failing: ${h.url}`, body: `Fail count: ${h.failCount}`,
      link: `/ticket-webhooks`, occurredAt: (h.lastDeliveryAt ?? now).toISOString(),
    })

    items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

    const counters = {
      total:    items.length,
      critical: items.filter(i => i.severity === "critical").length,
      warning:  items.filter(i => i.severity === "warning").length,
      byKind:   {} as Record<string, number>,
    }
    for (const i of items) counters.byKind[i.kind] = (counters.byKind[i.kind] ?? 0) + 1

    res.status(200).json({ counters, items: items.slice(0, 100), generatedAt: now.toISOString() })
  } catch (err) { next(err) }
}
