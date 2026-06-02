import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

export async function listForUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string
    const rows = await prisma.userNote.findMany({
      where: { userId },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 100,
    })
    // Resolve author identities
    const authorIds = Array.from(new Set(rows.map(r => r.authorId)))
    const authors = authorIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const aMap = new Map(authors.map(a => [a.id, a]))
    res.status(200).json({ data: rows.map(r => ({ ...r, author: aMap.get(r.authorId) ?? null })) })
  } catch (err) { next(err) }
}

export async function createNote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const userId = req.params.userId as string
    const { body, pinned, category } = req.body as Record<string, unknown>
    if (typeof body !== "string" || !body.trim()) throw badRequest("body required")
    const row = await prisma.userNote.create({
      data: {
        userId, authorId: actorId, body,
        pinned: pinned === true,
        category: typeof category === "string" ? category : null,
      },
    })
    await adminAuditR(req, res, {
      action: "user_note.create", targetType: "UserNote", targetId: row.id,
      metadata: { userId, pinned: pinned === true, category },
    })
    res.status(200).json({ note: row })
  } catch (err) { next(err) }
}

export async function updateNote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.userNote.findUnique({ where: { id } })
    if (!existing) throw notFound("Note not found")
    const { body, pinned, category } = req.body as Record<string, unknown>
    const updated = await prisma.userNote.update({
      where: { id },
      data: {
        ...(typeof body     === "string"  ? { body } : {}),
        ...(typeof pinned   === "boolean" ? { pinned } : {}),
        ...(typeof category === "string" || category === null ? { category: category as string | null } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "user_note.update", targetType: "UserNote", targetId: id,
      metadata: { userId: existing.userId, fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ note: updated })
  } catch (err) { next(err) }
}

export async function deleteNote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.userNote.findUnique({ where: { id } })
    if (!existing) throw notFound("Note not found")
    await prisma.userNote.delete({ where: { id } })
    await adminAuditR(req, res, {
      action: "user_note.delete", targetType: "UserNote", targetId: id,
      metadata: { userId: existing.userId },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
