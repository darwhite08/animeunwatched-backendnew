import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { runAnomalyScan } from "../../lib/anomalyDetector"

/**
 * Anomaly admin surface. List + filter + acknowledge anomalies, plus
 * a manual scan trigger for ops who don't want to wait for the 5-min
 * worker tick.
 */

export async function listAnomalies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const kind     = typeof req.query.kind     === "string" ? req.query.kind     : undefined
    const severity = typeof req.query.severity === "string" ? req.query.severity : undefined
    const userId   = typeof req.query.userId   === "string" ? req.query.userId   : undefined
    const ip       = typeof req.query.ip       === "string" ? req.query.ip       : undefined
    const onlyOpen = req.query.onlyOpen !== "false"   // default true
    const page     = Math.max(1, Number(req.query.page) || 1)
    const limit    = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

    const where: Record<string, unknown> = {}
    if (kind)     where.kind     = kind
    if (severity) where.severity = severity
    if (userId)   where.userId   = userId
    if (ip)       where.ipAddress = ip
    if (onlyOpen) where.acknowledgedAt = null

    const [data, total, byKind] = await prisma.$transaction([
      prisma.anomalyEvent.findMany({
        where, orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.anomalyEvent.count({ where }),
      prisma.anomalyEvent.groupBy({
        by: ["kind"], where: { acknowledgedAt: null }, _count: { _all: true }, orderBy: { kind: "asc" },
      }),
    ])

    res.status(200).json({
      data, total, page, limit,
      counters: Object.fromEntries(byKind.map(r => [r.kind, (r._count as { _all: number })?._all ?? 0])),
    })
  } catch (err) { next(err) }
}

export async function ackAnomaly(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const row = await prisma.anomalyEvent.findUnique({ where: { id } })
    if (!row) throw notFound("Anomaly not found")
    if (row.acknowledgedAt) { res.status(200).json({ ok: true, alreadyAcked: true }); return }
    await prisma.anomalyEvent.update({
      where: { id }, data: { acknowledgedAt: new Date(), acknowledgedBy: actorId },
    })
    await adminAuditR(req, res, {
      action: "anomaly.ack", targetType: "AnomalyEvent", targetId: id,
      metadata: { kind: row.kind, severity: row.severity },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function bulkAckAnomalies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { ids, kind } = req.body as { ids?: string[]; kind?: string }
    let updated = 0
    if (Array.isArray(ids) && ids.length > 0) {
      const r = await prisma.anomalyEvent.updateMany({
        where: { id: { in: ids }, acknowledgedAt: null },
        data:  { acknowledgedAt: new Date(), acknowledgedBy: actorId },
      })
      updated = r.count
    } else if (kind) {
      // Ack-all of a kind
      const r = await prisma.anomalyEvent.updateMany({
        where: { kind, acknowledgedAt: null },
        data:  { acknowledgedAt: new Date(), acknowledgedBy: actorId },
      })
      updated = r.count
    } else {
      throw badRequest("ids[] or kind required")
    }
    await adminAuditR(req, res, {
      action: "anomaly.bulk_ack",
      metadata: { ids: ids?.length, kind, updated },
    })
    res.status(200).json({ updated })
  } catch (err) { next(err) }
}

/** Manual scan trigger — for ops debugging without waiting for the 5-min cron. */
export async function triggerScan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await runAnomalyScan()
    await adminAuditR(req, res, {
      action: "anomaly.scan_triggered", metadata: { detected: result.detected, byKind: result.byKind },
    })
    res.status(200).json(result)
  } catch (err) { next(err) }
}
