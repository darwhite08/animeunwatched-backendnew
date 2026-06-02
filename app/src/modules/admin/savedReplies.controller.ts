import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

/**
 * Canned response library for support. Mods/operators pick from a short
 * list, tweak {{vars}}, and paste into wherever they're replying.
 * Use-count auto-increments on `/use` so the picker can sort by popularity.
 */

export async function listReplies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const category = typeof req.query.category === "string" ? req.query.category : undefined
    const search   = typeof req.query.search   === "string" ? req.query.search   : undefined
    const where: Record<string, unknown> = {}
    if (category) where.category = category
    if (search) {
      where.OR = [
        { title:    { contains: search, mode: "insensitive" } },
        { body:     { contains: search, mode: "insensitive" } },
        { shortcut: { contains: search, mode: "insensitive" } },
      ]
    }
    const data = await prisma.savedReply.findMany({
      where, orderBy: [{ useCount: "desc" }, { title: "asc" }],
      take: 200,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createReply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { title, body, category, shortcut } = req.body as Record<string, unknown>
    if (typeof title !== "string" || typeof body !== "string") throw badRequest("title and body required")
    if (shortcut && typeof shortcut === "string") {
      const exists = await prisma.savedReply.findUnique({ where: { shortcut } })
      if (exists) throw badRequest(`shortcut "${shortcut}" already in use`)
    }
    const row = await prisma.savedReply.create({
      data: {
        title, body,
        category: typeof category === "string" ? category : null,
        shortcut: typeof shortcut === "string" ? shortcut : null,
        createdBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "saved_reply.create", targetType: "SavedReply", targetId: row.id,
      metadata: { title, category, shortcut },
    })
    res.status(200).json({ reply: row })
  } catch (err) { next(err) }
}

export async function updateReply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const reply = await prisma.savedReply.findUnique({ where: { id } })
    if (!reply) throw notFound("Reply not found")
    const { title, body, category, shortcut } = req.body as Record<string, unknown>
    const updated = await prisma.savedReply.update({
      where: { id },
      data: {
        ...(typeof title    === "string" ? { title }    : {}),
        ...(typeof body     === "string" ? { body }     : {}),
        ...(typeof category === "string" || category === null ? { category: category as string | null } : {}),
        ...(typeof shortcut === "string" || shortcut === null ? { shortcut: shortcut as string | null } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "saved_reply.update", targetType: "SavedReply", targetId: id,
      metadata: { title, category, shortcut },
    })
    res.status(200).json({ reply: updated })
  } catch (err) { next(err) }
}

export async function deleteReply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.savedReply.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "saved_reply.delete", targetType: "SavedReply", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function markUsed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.savedReply.update({
      where: { id }, data: { useCount: { increment: 1 } },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
