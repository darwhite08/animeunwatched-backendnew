import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { getResults } from "../../lib/experiments"

const VALID_STATUS = ["draft", "running", "paused", "completed"] as const

export async function listExperiments(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.experiment.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: { variants: { orderBy: { name: "asc" } } },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createExperiment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { key, description, primaryMetric, variants } = req.body as Record<string, unknown>
    if (typeof key !== "string" || !/^[a-z0-9_]+$/.test(key)) throw badRequest("key must be lowercase letters, digits, underscores")
    if (typeof primaryMetric !== "string" || !primaryMetric.trim()) throw badRequest("primaryMetric required")
    if (!Array.isArray(variants) || variants.length < 2) throw badRequest("At least 2 variants required")
    const total = variants.reduce((s, v) => s + Number((v as { weight?: number }).weight ?? 0), 0)
    if (total !== 100) throw badRequest(`Variant weights must sum to 100 (got ${total})`)
    if (!variants.some(v => (v as { isControl?: boolean }).isControl)) throw badRequest("Exactly one variant must be isControl: true")

    const exp = await prisma.experiment.create({
      data: {
        key, primaryMetric,
        description: typeof description === "string" ? description : null,
        createdBy:   actorId,
        variants: {
          create: variants.map(v => {
            const vv = v as { name?: string; weight?: number; isControl?: boolean; payload?: unknown }
            if (!vv.name) throw badRequest("Each variant needs a name")
            return {
              name:      String(vv.name),
              weight:    Number(vv.weight ?? 0),
              isControl: !!vv.isControl,
              payload:   (vv.payload ?? null) as never,
            }
          }),
        },
      },
      include: { variants: true },
    })
    await adminAuditR(req, res, {
      action: "experiment.create", targetType: "Experiment", targetId: exp.id,
      metadata: { key, variants: exp.variants.length },
    })
    res.status(200).json({ experiment: exp })
  } catch (err) { next(err) }
}

export async function transitionExperiment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const status = (req.body as { status?: string }).status
    if (!VALID_STATUS.includes(status as typeof VALID_STATUS[number])) throw badRequest(`status ∈ ${VALID_STATUS.join("|")}`)
    const exp = await prisma.experiment.findUnique({ where: { id } })
    if (!exp) throw notFound("Experiment not found")
    const data: Record<string, unknown> = { status: status as string }
    if (status === "running"   && !exp.startedAt) data.startedAt = new Date()
    if (status === "completed" && !exp.endedAt)   data.endedAt   = new Date()
    const updated = await prisma.experiment.update({ where: { id }, data })
    await adminAuditR(req, res, {
      action: `experiment.${status}`, targetType: "Experiment", targetId: id,
      metadata: { key: exp.key },
    })
    res.status(200).json({ experiment: updated })
  } catch (err) { next(err) }
}

export async function getExperimentResults(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const exp = await prisma.experiment.findUnique({ where: { id } })
    if (!exp) throw notFound("Experiment not found")
    const results = await getResults(exp.key)
    res.status(200).json({ key: exp.key, status: exp.status, startedAt: exp.startedAt, endedAt: exp.endedAt, ...results })
  } catch (err) { next(err) }
}

export async function deleteExperiment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.experiment.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "experiment.delete", targetType: "Experiment", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
