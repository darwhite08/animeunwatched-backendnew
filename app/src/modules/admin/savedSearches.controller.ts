import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound, forbidden } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

export async function listForResource(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const resource = req.params.resource as string
    const data = await prisma.savedSearch.findMany({
      where: { resource, OR: [{ ownerId: actorId }, { shared: true }] },
      orderBy: [{ pinned: "desc" }, { name: "asc" }],
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { resource, name, query, shared, pinned } = req.body as Record<string, unknown>
    if (typeof resource !== "string" || !resource.trim()) throw badRequest("resource required")
    if (typeof name     !== "string" || !name.trim())     throw badRequest("name required")
    if (typeof query    !== "string")                     throw badRequest("query required")
    const row = await prisma.savedSearch.upsert({
      where: { ownerId_resource_name: { ownerId: actorId, resource, name: name.trim() } },
      update: { query, shared: shared === true, pinned: pinned === true },
      create: { ownerId: actorId, resource, name: name.trim(), query, shared: shared === true, pinned: pinned === true },
    })
    await adminAuditR(req, res, { action: "saved_search.upsert", targetType: "SavedSearch", targetId: row.id, metadata: { resource, name } })
    res.status(200).json({ search: row })
  } catch (err) { next(err) }
}

export async function deleteSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const existing = await prisma.savedSearch.findUnique({ where: { id } })
    if (!existing) throw notFound("Search not found")
    if (existing.ownerId !== actorId) throw forbidden("Only the owner can delete")
    await prisma.savedSearch.delete({ where: { id } })
    await adminAuditR(req, res, { action: "saved_search.delete", targetType: "SavedSearch", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
