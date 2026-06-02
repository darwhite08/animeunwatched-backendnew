import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound, forbidden } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { DASHBOARD_SOURCES, isSafeSource } from "../../lib/dashboardSources"

const VALID_KIND = ["stat", "table", "chart", "text"] as const

export async function listSources(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json({ data: DASHBOARD_SOURCES }) } catch (err) { next(err) }
}

export async function listDashboards(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const data = await prisma.dashboard.findMany({
      where: { OR: [{ shared: true }, { ownerId: actorId }] },
      orderBy: [{ shared: "desc" }, { updatedAt: "desc" }],
      include: { _count: { select: { widgets: true } } },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function getDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const actorId = res.locals.user?.id as string
    const d = await prisma.dashboard.findUnique({
      where: { id },
      include: { widgets: { orderBy: [{ y: "asc" }, { x: "asc" }] } },
    })
    if (!d) throw notFound("Dashboard not found")
    if (!d.shared && d.ownerId !== actorId) throw forbidden("Not your dashboard")
    res.status(200).json(d)
  } catch (err) { next(err) }
}

export async function createDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, description, shared, layout } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim()) throw badRequest("name required")
    const d = await prisma.dashboard.create({
      data: {
        name: name.trim(),
        description: typeof description === "string" ? description : null,
        shared:      shared === true,
        layout:      (layout ?? {}) as never,
        ownerId:     actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "dashboard.create", targetType: "Dashboard", targetId: d.id,
      metadata: { name: d.name, shared: d.shared },
    })
    res.status(200).json({ dashboard: d })
  } catch (err) { next(err) }
}

export async function updateDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const actorId = res.locals.user?.id as string
    const existing = await prisma.dashboard.findUnique({ where: { id } })
    if (!existing) throw notFound("Dashboard not found")
    if (existing.ownerId !== actorId) throw forbidden("Only the owner can edit this dashboard")
    const { name, description, shared, layout } = req.body as Record<string, unknown>
    const updated = await prisma.dashboard.update({
      where: { id },
      data: {
        ...(typeof name        === "string"  ? { name: name.trim() } : {}),
        ...(typeof description === "string" || description === null ? { description: description as string | null } : {}),
        ...(typeof shared      === "boolean" ? { shared } : {}),
        ...(layout !== undefined ? { layout: layout as never } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "dashboard.update", targetType: "Dashboard", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ dashboard: updated })
  } catch (err) { next(err) }
}

export async function deleteDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const actorId = res.locals.user?.id as string
    const existing = await prisma.dashboard.findUnique({ where: { id } })
    if (!existing) throw notFound("Dashboard not found")
    if (existing.ownerId !== actorId) throw forbidden("Only the owner can delete this dashboard")
    await prisma.dashboard.delete({ where: { id } })
    await adminAuditR(req, res, { action: "dashboard.delete", targetType: "Dashboard", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function upsertWidget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dashboardId = req.params.id as string
    const widgetId    = typeof req.params.widgetId === "string" ? req.params.widgetId : undefined
    const actorId = res.locals.user?.id as string
    const dash = await prisma.dashboard.findUnique({ where: { id: dashboardId } })
    if (!dash) throw notFound("Dashboard not found")
    if (dash.ownerId !== actorId) throw forbidden("Only the owner can edit widgets")

    const { kind, source, title, configJson, x, y, w, h } = req.body as Record<string, unknown>
    if (!VALID_KIND.includes(kind as typeof VALID_KIND[number])) throw badRequest(`kind ∈ ${VALID_KIND.join("|")}`)
    if (typeof source !== "string" || !isSafeSource(source))     throw badRequest(`source must be one of the registered keys`)
    if (typeof title  !== "string" || !title.trim())             throw badRequest("title required")
    const data = {
      kind: kind as string, source, title: title.trim(),
      configJson: (configJson ?? {}) as never,
      x: Number(x) || 0, y: Number(y) || 0, w: Number(w) || 4, h: Number(h) || 3,
      dashboardId,
    }
    const row = widgetId
      ? await prisma.dashboardWidget.update({ where: { id: widgetId }, data })
      : await prisma.dashboardWidget.create({ data })
    await adminAuditR(req, res, {
      action: widgetId ? "dashboard.widget.update" : "dashboard.widget.create",
      targetType: "DashboardWidget", targetId: row.id,
      metadata: { dashboardId, title, source },
    })
    res.status(200).json({ widget: row })
  } catch (err) { next(err) }
}

export async function deleteWidget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const widgetId = req.params.widgetId as string
    const actorId = res.locals.user?.id as string
    const w = await prisma.dashboardWidget.findUnique({ where: { id: widgetId }, include: { dashboard: true } })
    if (!w) throw notFound("Widget not found")
    if (w.dashboard.ownerId !== actorId) throw forbidden("Only the owner can delete widgets")
    await prisma.dashboardWidget.delete({ where: { id: widgetId } })
    await adminAuditR(req, res, { action: "dashboard.widget.delete", targetType: "DashboardWidget", targetId: widgetId })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
