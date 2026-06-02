import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const SCOPES = ["all", "api", "uploads", "admin"] as const

export async function listMaintenance(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.maintenanceWindow.findMany({
      orderBy: { startsAt: "desc" },
      take:    50,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

/** Currently-active windows. Public-ish — frontends can render their own
 *  banners from this without admin auth. */
export async function currentMaintenance(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = new Date()
    const data = await prisma.maintenanceWindow.findMany({
      where:   { startsAt: { lte: now }, endsAt: { gte: now }, cancelledAt: null },
      orderBy: { startsAt: "asc" },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { title, description, scope, startsAt, endsAt } = req.body as Record<string, unknown>
    if (typeof title !== "string" || typeof startsAt !== "string" || typeof endsAt !== "string") {
      throw badRequest("title, startsAt, endsAt required")
    }
    if (scope && !SCOPES.includes(scope as typeof SCOPES[number])) throw badRequest(`scope ∈ ${SCOPES.join("|")}`)
    const startDate = new Date(startsAt)
    const endDate   = new Date(endsAt)
    if (endDate <= startDate) throw badRequest("endsAt must be after startsAt")
    const row = await prisma.maintenanceWindow.create({
      data: {
        title,
        description: typeof description === "string" ? description : null,
        scope:       (scope as string) ?? "all",
        startsAt:    startDate,
        endsAt:      endDate,
        createdBy:   actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "maintenance.create", targetType: "MaintenanceWindow", targetId: row.id,
      metadata: { title, scope, startsAt, endsAt },
    })
    res.status(200).json({ window: row })
  } catch (err) { next(err) }
}

export async function cancelMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const w = await prisma.maintenanceWindow.findUnique({ where: { id } })
    if (!w) throw notFound("Window not found")
    if (w.cancelledAt) { res.status(200).json({ window: w }); return }
    const updated = await prisma.maintenanceWindow.update({
      where: { id }, data: { cancelledAt: new Date() },
    })
    await adminAuditR(req, res, {
      action: "maintenance.cancel", targetType: "MaintenanceWindow", targetId: id,
      metadata: { title: w.title },
    })
    res.status(200).json({ window: updated })
  } catch (err) { next(err) }
}

export async function deleteMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.maintenanceWindow.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "maintenance.delete", targetType: "MaintenanceWindow", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
