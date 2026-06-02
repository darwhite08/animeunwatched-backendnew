import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { seedPiiInventory } from "../../lib/piiScanner"

const VALID_CLASS = ["identifier", "contact", "sensitive", "behavioral", "device"] as const
const VALID_BASIS = ["consent", "contract", "legitimate_interest", "legal_obligation"] as const
const VALID_ROLE  = ["USER", "MOD", "ADMIN"] as const

export async function listPii(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const klass = typeof req.query.classification === "string" ? req.query.classification : undefined
    const model = typeof req.query.model          === "string" ? req.query.model          : undefined
    const data = await prisma.piiField.findMany({
      where: { ...(klass ? { classification: klass } : {}), ...(model ? { model } : {}) },
      orderBy: [{ model: "asc" }, { field: "asc" }],
    })
    // Summary counters per classification for the header chips
    const counters: Record<string, number> = {}
    for (const r of data) counters[r.classification] = (counters[r.classification] ?? 0) + 1
    const unreviewed = data.filter(r => !r.reviewedAt).length
    res.status(200).json({ data, counters, unreviewed, total: data.length })
  } catch (err) { next(err) }
}

export async function updatePii(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const actorId = res.locals.user?.id as string
    const row = await prisma.piiField.findUnique({ where: { id } })
    if (!row) throw notFound("PII field not found")
    const { classification, legalBasis, retentionDays, readRoleMin, description } = req.body as Record<string, unknown>
    if (classification && !VALID_CLASS.includes(classification as typeof VALID_CLASS[number])) throw badRequest(`classification ∈ ${VALID_CLASS.join("|")}`)
    if (legalBasis     && !VALID_BASIS.includes(legalBasis as typeof VALID_BASIS[number]))     throw badRequest(`legalBasis ∈ ${VALID_BASIS.join("|")}`)
    if (readRoleMin    && !VALID_ROLE.includes(readRoleMin as typeof VALID_ROLE[number]))      throw badRequest(`readRoleMin ∈ ${VALID_ROLE.join("|")}`)
    const updated = await prisma.piiField.update({
      where: { id },
      data: {
        ...(typeof classification === "string" ? { classification } : {}),
        ...(typeof legalBasis     === "string" ? { legalBasis }     : {}),
        ...(retentionDays === null || typeof retentionDays === "number" ? { retentionDays: retentionDays as number | null } : {}),
        ...(typeof readRoleMin    === "string" ? { readRoleMin }    : {}),
        ...(typeof description    === "string" ? { description }    : {}),
        reviewedAt: new Date(),
        reviewedBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "pii.update", targetType: "PiiField", targetId: id,
      metadata: { model: row.model, field: row.field, fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ field: updated })
  } catch (err) { next(err) }
}

export async function reseedPii(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const r = await seedPiiInventory()
    await adminAuditR(req, res, { action: "pii.reseed", metadata: r })
    res.status(200).json(r)
  } catch (err) { next(err) }
}

/** Public RoPA-style export — list of fields grouped by classification for
 *  legal reviews. No PII content, just the schema itself. */
export async function exportRopa(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.piiField.findMany({ orderBy: [{ classification: "asc" }, { model: "asc" }, { field: "asc" }] })
    const grouped: Record<string, Array<{ model: string; field: string; legalBasis: string | null; retentionDays: number | null; readRoleMin: string; description: string | null }>> = {}
    for (const r of rows) {
      const k = r.classification
      grouped[k] = grouped[k] ?? []
      grouped[k].push({ model: r.model, field: r.field, legalBasis: r.legalBasis, retentionDays: r.retentionDays, readRoleMin: r.readRoleMin, description: r.description })
    }
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      controller:  "Kaiveron",
      categories:  Object.keys(grouped).sort(),
      grouped,
      total:       rows.length,
    })
  } catch (err) { next(err) }
}
