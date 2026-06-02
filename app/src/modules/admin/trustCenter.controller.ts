import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const VALID_KIND = ["certification", "document", "contact", "principle", "audit_report"] as const

export async function listEntries(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.trustCenterEntry.findMany({ orderBy: [{ active: "desc" }, { kind: "asc" }, { order: "asc" }] })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = typeof req.params.id === "string" ? req.params.id : undefined
    const { kind, title, body, url, validUntil, order, active } = req.body as Record<string, unknown>
    if (!VALID_KIND.includes(kind as typeof VALID_KIND[number])) throw badRequest(`kind ∈ ${VALID_KIND.join("|")}`)
    if (typeof title !== "string" || !title.trim())  throw badRequest("title required")
    const data = {
      kind: kind as string, title: title.trim(),
      body:       typeof body === "string" ? body : null,
      url:        typeof url  === "string" ? url  : null,
      validUntil: typeof validUntil === "string" ? new Date(validUntil) : null,
      order:      Number(order) || 0,
      active:     active !== false,
    }
    const row = id
      ? await prisma.trustCenterEntry.update({ where: { id }, data })
      : await prisma.trustCenterEntry.create({ data: { ...data, createdBy: actorId } })
    await adminAuditR(req, res, {
      action: id ? "trust.update" : "trust.create", targetType: "TrustCenterEntry", targetId: row.id,
      metadata: { kind, title },
    })
    res.status(200).json({ entry: row })
  } catch (err) { next(err) }
}

export async function deleteEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.trustCenterEntry.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "trust.delete", targetType: "TrustCenterEntry", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
