import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

/**
 * M-Ops — incident lifecycle. Statuses: open → investigating → identified
 * → monitoring → resolved. Each transition writes an IncidentUpdate row
 * so the timeline is preserved separately from the current state.
 */

const VALID_STATUS = ["open", "investigating", "identified", "monitoring", "resolved"] as const
const VALID_SEV    = ["sev1", "sev2", "sev3", "sev4"] as const

export async function listIncidents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status   = typeof req.query.status   === "string" ? req.query.status   : undefined
    const severity = typeof req.query.severity === "string" ? req.query.severity : undefined
    const where: Record<string, unknown> = {}
    if (status)   where.status = status
    if (severity) where.severity = severity
    const data = await prisma.incident.findMany({
      where, orderBy: [{ status: "asc" }, { startedAt: "desc" }],
      take: 100,
      include: { _count: { select: { updates: true } } },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function getIncident(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const inc = await prisma.incident.findUnique({
      where: { id },
      include: { updates: { orderBy: { createdAt: "asc" } } },
    })
    if (!inc) throw notFound("Incident not found")
    res.status(200).json(inc)
  } catch (err) { next(err) }
}

export async function createIncident(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { title, severity, category, impactedAreas, detectedAt } = req.body as Record<string, unknown>
    if (typeof title !== "string" || typeof severity !== "string" || typeof category !== "string") {
      throw badRequest("title, severity, category required")
    }
    if (!VALID_SEV.includes(severity as typeof VALID_SEV[number])) throw badRequest(`severity ∈ ${VALID_SEV.join("|")}`)

    const inc = await prisma.incident.create({
      data: {
        title, severity, category,
        impactedAreas: (impactedAreas ?? []) as never,
        detectedAt:    detectedAt ? new Date(detectedAt as string) : new Date(),
        openedBy:      actorId,
      },
    })
    await prisma.incidentUpdate.create({
      data: { incidentId: inc.id, status: "open", message: "Incident opened.", authorId: actorId },
    })
    await adminAuditR(req, res, {
      action: "incident.create", targetType: "Incident", targetId: inc.id,
      metadata: { title, severity, category },
    })

    // Critical severity also raises an AdminAlert + fans through the
    // notification router so it lands in the overview attention panel AND
    // pages any configured channels.
    if (severity === "sev1" || severity === "sev2") {
      const { raiseAlert } = await import("../../lib/raiseAlert")
      await raiseAlert({
        severity: "critical", category: "uptime",
        title:    `${severity.toUpperCase()}: ${title}`,
        link:     `/incidents/${inc.id}`,
        metadata: { incidentId: inc.id, category: inc.category },
      })
    }
    res.status(200).json({ incident: inc })
  } catch (err) { next(err) }
}

export async function appendUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const { status, message } = req.body as { status?: string; message?: string }
    if (!message)                                                       throw badRequest("message required")
    if (status && !VALID_STATUS.includes(status as typeof VALID_STATUS[number])) throw badRequest(`status ∈ ${VALID_STATUS.join("|")}`)
    const inc = await prisma.incident.findUnique({ where: { id } })
    if (!inc) throw notFound("Incident not found")

    const update = await prisma.incidentUpdate.create({
      data: { incidentId: id, status: status ?? inc.status, message, authorId: actorId },
    })
    // Move the incident itself to the new status if one was supplied.
    if (status && status !== inc.status) {
      await prisma.incident.update({
        where: { id },
        data: { status, ...(status === "resolved" ? { resolvedAt: new Date() } : {}) },
      })
    }
    await adminAuditR(req, res, {
      action: "incident.update", targetType: "Incident", targetId: id,
      metadata: { newStatus: status ?? inc.status, messagePreview: message.slice(0, 200) },
    })
    res.status(200).json({ update })
  } catch (err) { next(err) }
}

export async function patchIncident(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const { postmortem, rootCause, title, category, severity, impactedAreas } = req.body as Record<string, unknown>
    const inc = await prisma.incident.findUnique({ where: { id } })
    if (!inc) throw notFound("Incident not found")
    const updated = await prisma.incident.update({
      where: { id },
      data: {
        ...(typeof postmortem === "string" ? { postmortem } : {}),
        ...(typeof rootCause  === "string" ? { rootCause }  : {}),
        ...(typeof title      === "string" ? { title }      : {}),
        ...(typeof category   === "string" ? { category }   : {}),
        ...(typeof severity   === "string" && VALID_SEV.includes(severity as typeof VALID_SEV[number]) ? { severity } : {}),
        ...(Array.isArray(impactedAreas) ? { impactedAreas: impactedAreas as never } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "incident.patch", targetType: "Incident", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ incident: updated })
  } catch (err) { next(err) }
}

/**
 * Create an incident pre-filled from an unacked AdminAlert. Speeds up the
 * "we got paged, declare it" path so the on-call doesn't retype severity
 * + category + title.
 *
 * Severity mapping: alert.severity "critical" → sev2 (caller can bump to
 * sev1 in the open-update). Acks the alert in the same transaction so the
 * inbox count drops.
 */
export async function declareFromAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const alertId = req.params.alertId as string
    const alert = await prisma.adminAlert.findUnique({ where: { id: alertId } })
    if (!alert) throw notFound("Alert not found")

    const sev = alert.severity === "critical" ? "sev2" : alert.severity === "warning" ? "sev3" : "sev4"
    const inc = await prisma.incident.create({
      data: {
        title:    alert.title.replace(/^\[?[A-Z]+\]?:?\s*/, "").slice(0, 200) || alert.title,
        severity: sev,
        category: alert.category,
        impactedAreas: [] as never,
        detectedAt: alert.createdAt,
        openedBy:   actorId,
      },
    })
    await prisma.incidentUpdate.create({
      data: { incidentId: inc.id, status: "open", message: `Incident declared from alert "${alert.title}"`, authorId: actorId },
    })
    if (!alert.acknowledgedAt) {
      await prisma.adminAlert.update({ where: { id: alertId }, data: { acknowledgedAt: new Date(), acknowledgedBy: actorId } })
    }
    await adminAuditR(req, res, {
      action: "incident.declare_from_alert", targetType: "Incident", targetId: inc.id,
      metadata: { alertId, severity: sev, category: alert.category },
    })
    res.status(200).json({ incident: inc })
  } catch (err) { next(err) }
}

/**
 * Resolve-time recap: total duration, # of updates, related alerts during
 * the window, mean response from open to first update (rough MTTA).
 */
export async function getIncidentRecap(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const inc = await prisma.incident.findUnique({
      where: { id },
      include: { updates: { orderBy: { createdAt: "asc" } } },
    })
    if (!inc) throw notFound("Incident not found")

    const closedAt   = inc.resolvedAt ?? new Date()
    const totalMs    = closedAt.getTime() - inc.startedAt.getTime()
    const firstUpdate = inc.updates.find(u => u.message !== "Incident opened.")
    const mttaMs     = firstUpdate ? firstUpdate.createdAt.getTime() - inc.startedAt.getTime() : null
    const alertsInWindow = await prisma.adminAlert.count({
      where: { createdAt: { gte: inc.startedAt, lte: closedAt } },
    })

    res.status(200).json({
      durationMs:    totalMs,
      durationHuman: humanizeDuration(totalMs),
      mttaMs:        mttaMs,
      mttaHuman:     mttaMs !== null ? humanizeDuration(mttaMs) : null,
      updateCount:   inc.updates.length,
      alertsInWindow,
      hasPostmortem: !!inc.postmortem,
      hasRootCause:  !!inc.rootCause,
    })
  } catch (err) { next(err) }
}

function humanizeDuration(ms: number): string {
  if (ms < 60_000)         return `${Math.round(ms / 1000)}s`
  if (ms < 60 * 60_000)    return `${Math.round(ms / 60_000)}m`
  if (ms < 24 * 60 * 60_000) return `${(ms / (60 * 60_000)).toFixed(1)}h`
  return `${(ms / (24 * 60 * 60_000)).toFixed(1)}d`
}

/** Bulk-resolve several incidents (sev3/sev4 cleanup, scheduled post-mortems). */
export async function bulkResolve(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { incidentIds, postmortem } = req.body as { incidentIds?: unknown; postmortem?: string }
    if (!Array.isArray(incidentIds) || incidentIds.length === 0) throw badRequest("incidentIds[] required")
    const ids = incidentIds.map(String).slice(0, 50)
    const r = await prisma.incident.updateMany({
      where: { id: { in: ids }, status: { not: "resolved" } },
      data:  { status: "resolved", resolvedAt: new Date(), ...(typeof postmortem === "string" ? { postmortem } : {}) },
    })
    await adminAuditR(req, res, {
      action: "incident.bulk_resolve", targetType: "Incident",
      metadata: { resolved: r.count, requested: ids.length },
    })
    res.status(200).json({ resolved: r.count })
  } catch (err) { next(err) }
}
