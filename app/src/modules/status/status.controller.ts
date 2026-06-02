import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Public status feed — no auth. Powers a status banner on kaiveron.com
 * and the dedicated status.kaiveron.com page. Combines current maintenance
 * windows + recent incidents (last 30 days) + the most recent update on each
 * open incident so the consumer needs only one call.
 */
export async function publicStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now      = new Date()
    const thirtyD  = new Date(Date.now() - 30 * 24 * 60 * 60_000)

    const [active, scheduled, recent, openIncidents] = await Promise.all([
      prisma.maintenanceWindow.findMany({
        where: { startsAt: { lte: now }, endsAt: { gte: now }, cancelledAt: null },
        orderBy: { startsAt: "asc" },
      }),
      prisma.maintenanceWindow.findMany({
        where: { startsAt: { gt: now }, cancelledAt: null },
        orderBy: { startsAt: "asc" }, take: 10,
      }),
      prisma.incident.findMany({
        where: { startedAt: { gte: thirtyD } },
        orderBy: { startedAt: "desc" }, take: 30,
        include: { updates: { orderBy: { createdAt: "desc" }, take: 1 } },
      }),
      prisma.incident.findMany({
        where: { status: { not: "resolved" } },
        orderBy: { startedAt: "desc" },
      }),
    ])

    const overall =
      active.length > 0          ? "maintenance" :
      openIncidents.some(i => i.severity === "sev1") ? "major_outage" :
      openIncidents.some(i => i.severity === "sev2") ? "partial_outage" :
      openIncidents.length > 0   ? "degraded" :
                                   "operational"

    res.status(200).json({
      overall,
      generatedAt: now.toISOString(),
      maintenance: {
        active:    active.map(w => ({ id: w.id, title: w.title, scope: w.scope, startsAt: w.startsAt, endsAt: w.endsAt, description: w.description })),
        scheduled: scheduled.map(w => ({ id: w.id, title: w.title, scope: w.scope, startsAt: w.startsAt, endsAt: w.endsAt })),
      },
      incidents: {
        open:   openIncidents.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, startedAt: i.startedAt })),
        recent: recent.map(i => ({
          id: i.id, title: i.title, severity: i.severity, status: i.status,
          startedAt: i.startedAt, resolvedAt: i.resolvedAt,
          latestUpdate: i.updates[0] ? { status: i.updates[0].status, message: i.updates[0].message, createdAt: i.updates[0].createdAt } : null,
        })),
      },
    })
  } catch (err) { next(err) }
}
