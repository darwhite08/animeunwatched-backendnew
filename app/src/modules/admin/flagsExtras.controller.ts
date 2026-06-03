import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { notFound } from "../../lib/errors"

/**
 * Read-side helpers for the flag rollout workflow page. Both endpoints
 * are observability-only — no mutations.
 *
 * /admin/flags/:id/impact — last-24h endpoint volume that could be flagged-
 * gated (best-effort: returns total request rate from EndpointStat so the
 * admin sees roughly how many requests the rollout touches).
 *
 * /admin/flags/:id/audit — audit log filtered to this flag's mutations.
 */

export async function getFlagImpact(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const flag = await prisma.featureFlag.findUnique({ where: { id } })
    if (!flag) throw notFound("Flag not found")

    const since = new Date(Date.now() - 24 * 60 * 60_000)
    const stats = await prisma.endpointStat.findMany({ where: { hourBucket: { gte: since } } })
    const totalReq    = stats.reduce((s, r) => s + r.requests, 0)
    const totalErr    = stats.reduce((s, r) => s + r.errors, 0)
    const overrides   = await prisma.featureFlagOverride.count({ where: { flagId: id } })
    const rolloutPct  = readRolloutPct(flag.rolloutRules)
    const reachedRequests = flag.enabledGlobally ? totalReq : Math.round(totalReq * (rolloutPct / 100))

    res.status(200).json({
      windowHours: 24,
      flag: { key: flag.key, enabledGlobally: flag.enabledGlobally, isKillSwitch: flag.isKillSwitch, killedAt: flag.killedAt, lastEvaluatedAt: flag.lastEvaluatedAt },
      rolloutPct,
      overrides,
      totalRequests: totalReq,
      totalErrors:   totalErr,
      errorRatePct:  totalReq > 0 ? +(totalErr / totalReq * 100).toFixed(2) : 0,
      estimatedReachedRequests: reachedRequests,
    })
  } catch (err) { next(err) }
}

function readRolloutPct(rules: unknown): number {
  if (!rules || typeof rules !== "object") return 0
  const r = rules as { percentage?: unknown }
  const n = Number(r.percentage)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export async function getFlagAudit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const flag = await prisma.featureFlag.findUnique({ where: { id } })
    if (!flag) throw notFound("Flag not found")
    const rows = await prisma.auditLog.findMany({
      where: { targetType: "FeatureFlag", targetId: id },
      orderBy: { createdAt: "desc" }, take: 50,
    })
    res.status(200).json({ data: rows, flag: { id: flag.id, key: flag.key } })
  } catch (err) { next(err) }
}

/** Convenience setter for the rollout slider — wraps updateFlag with a
 *  single-field PATCH so the UI doesn't have to round-trip the whole rules. */
export async function setRolloutPercent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const { percentage } = req.body as { percentage?: number }
    const p = Number(percentage)
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "percentage must be 0..100" } })
      return
    }
    const flag = await prisma.featureFlag.findUnique({ where: { id } })
    if (!flag) throw notFound("Flag not found")
    const current = (flag.rolloutRules && typeof flag.rolloutRules === "object" ? flag.rolloutRules : {}) as Record<string, unknown>
    const updated = await prisma.featureFlag.update({
      where: { id }, data: { rolloutRules: { ...current, percentage: Math.round(p) } as never },
    })
    // Audit
    const actorId = res.locals.user?.id as string
    const { adminAuditR } = await import("../../lib/adminAudit")
    await adminAuditR(req, res, {
      action: "flag.set_rollout", targetType: "FeatureFlag", targetId: id,
      metadata: { actorId, from: readRolloutPct(flag.rolloutRules), to: Math.round(p), key: flag.key },
    })
    res.status(200).json({ flag: updated })
  } catch (err) { next(err) }
}
