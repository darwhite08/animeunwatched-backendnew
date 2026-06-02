import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const VALID_KINDS = ["db", "uploads", "vault"] as const

export async function listBackups(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60_000)
    const data = await prisma.backupRecord.findMany({
      where: { completedAt: { gte: since }, ...(kind ? { kind } : {}) },
      orderBy: { completedAt: "desc" }, take: 500,
    })

    // Last successful backup per kind
    const latestByKind: Record<string, { id: string; completedAt: Date; verifiedAt: Date | null; ageHours: number }> = {}
    for (const k of VALID_KINDS) {
      const last = await prisma.backupRecord.findFirst({ where: { kind: k }, orderBy: { completedAt: "desc" } })
      if (last) {
        latestByKind[k] = {
          id: last.id, completedAt: last.completedAt, verifiedAt: last.verifiedAt,
          ageHours: +((Date.now() - last.completedAt.getTime()) / 3_600_000).toFixed(2),
        }
      }
    }
    // RPO summary — alert if last backup older than 24h (default)
    const RPO_HOURS = 24
    const overdue = Object.entries(latestByKind).filter(([, l]) => l.ageHours > RPO_HOURS).map(([k]) => k)

    res.status(200).json({ data, latestByKind, overdueKinds: overdue, rpoHours: RPO_HOURS })
  } catch (err) { next(err) }
}

export async function recordBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { kind, location, sizeBytes, durationMs, startedAt, completedAt, retentionUntil, notes } = req.body as Record<string, unknown>
    if (!VALID_KINDS.includes(kind as typeof VALID_KINDS[number])) throw badRequest(`kind ∈ ${VALID_KINDS.join("|")}`)
    if (typeof location !== "string" || !location.trim()) throw badRequest("location required")
    if (typeof startedAt   !== "string") throw badRequest("startedAt required (ISO)")
    if (typeof completedAt !== "string") throw badRequest("completedAt required (ISO)")
    if (typeof sizeBytes   !== "number" && typeof sizeBytes !== "string") throw badRequest("sizeBytes required")

    const row = await prisma.backupRecord.create({
      data: {
        kind: kind as string, location: location.trim(),
        sizeBytes: BigInt(Math.round(Number(sizeBytes))),
        durationMs:     typeof durationMs === "number" ? durationMs : null,
        startedAt:      new Date(startedAt),
        completedAt:    new Date(completedAt),
        retentionUntil: typeof retentionUntil === "string" ? new Date(retentionUntil) : null,
        notes:          typeof notes === "string" ? notes : null,
      },
    })
    await adminAuditR(req, res, {
      action: "backup.record", targetType: "BackupRecord", targetId: row.id,
      metadata: { kind, location, sizeBytes: row.sizeBytes.toString(), actorId },
    })
    res.status(200).json({ backup: { ...row, sizeBytes: row.sizeBytes.toString() } })
  } catch (err) { next(err) }
}

export async function verifyBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const actorId = res.locals.user?.id as string
    const b = await prisma.backupRecord.findUnique({ where: { id } })
    if (!b) throw notFound("Backup not found")
    const updated = await prisma.backupRecord.update({
      where: { id },
      data: { verifiedAt: new Date(), verifiedBy: actorId },
    })
    await adminAuditR(req, res, {
      action: "backup.verify", targetType: "BackupRecord", targetId: id,
      metadata: { kind: b.kind, location: b.location },
    })
    res.status(200).json({ backup: { ...updated, sizeBytes: updated.sizeBytes.toString() } })
  } catch (err) { next(err) }
}

export async function deleteBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.backupRecord.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "backup.delete", targetType: "BackupRecord", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
