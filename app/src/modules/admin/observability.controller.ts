import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const VALID_OBJ = ["availability", "latency_p99"] as const

// ---- SLO definitions --------------------------------------------------

export async function listSlos(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slos = await prisma.sloDefinition.findMany({ orderBy: { createdAt: "desc" } })
    // Compute current state for each SLO from EndpointStat
    const results = await Promise.all(slos.map(async (slo) => {
      const since = new Date(Date.now() - slo.windowDays * 24 * 60 * 60_000)
      const where: Record<string, unknown> = { hourBucket: { gte: since } }
      if (slo.endpoint !== "*") where.endpoint = slo.endpoint
      const stats = await prisma.endpointStat.findMany({ where })
      const totalReq    = stats.reduce((s, r) => s + r.requests, 0)
      const totalErr    = stats.reduce((s, r) => s + r.errors, 0)
      const maxP99      = stats.reduce((s, r) => Math.max(s, r.p99Ms), 0)
      let actualPct = 100, status: "ok" | "warn" | "breached" = "ok"
      if (slo.objectiveType === "availability") {
        actualPct = totalReq === 0 ? 100 : ((totalReq - totalErr) / totalReq) * 100
      } else if (slo.objectiveType === "latency_p99" && slo.thresholdMs) {
        // Approximate: % of buckets whose p99 stays under threshold
        const passed = stats.filter(s => s.p99Ms <= (slo.thresholdMs ?? 0)).length
        actualPct = stats.length === 0 ? 100 : (passed / stats.length) * 100
      }
      const errorBudgetUsedPct = slo.targetPct >= 100 ? 0 : Math.min(999, (100 - actualPct) / (100 - slo.targetPct) * 100)
      if (actualPct < slo.targetPct) status = "breached"
      else if (errorBudgetUsedPct > 75) status = "warn"
      return {
        ...slo,
        actualPct:        +actualPct.toFixed(3),
        errorBudgetUsedPct: +errorBudgetUsedPct.toFixed(1),
        status,
        observed: { totalReq, totalErr, maxP99 },
      }
    }))
    res.status(200).json({ data: results })
  } catch (err) { next(err) }
}

export async function upsertSlo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = typeof req.params.id === "string" ? req.params.id : undefined
    const { name, endpoint, objectiveType, targetPct, windowDays, thresholdMs } = req.body as Record<string, unknown>
    if (typeof name     !== "string" || !name.trim())     throw badRequest("name required")
    if (typeof endpoint !== "string" || !endpoint.trim()) throw badRequest("endpoint required (use '*' for global)")
    if (!VALID_OBJ.includes(objectiveType as typeof VALID_OBJ[number])) throw badRequest(`objectiveType ∈ ${VALID_OBJ.join("|")}`)
    const target = Number(targetPct)
    if (!Number.isFinite(target) || target <= 0 || target > 100) throw badRequest("targetPct must be 0 < x ≤ 100")
    if (objectiveType === "latency_p99" && (typeof thresholdMs !== "number" || thresholdMs <= 0)) {
      throw badRequest("thresholdMs required for latency_p99")
    }
    const data = {
      name: name.trim(), endpoint: endpoint.trim(), objectiveType: objectiveType as string,
      targetPct: target, windowDays: Number(windowDays) || 30,
      thresholdMs: objectiveType === "latency_p99" ? Number(thresholdMs) : null,
    }
    const row = id
      ? await prisma.sloDefinition.update({ where: { id }, data })
      : await prisma.sloDefinition.create({ data: { ...data, createdBy: actorId } })
    await adminAuditR(req, res, {
      action: id ? "slo.update" : "slo.create", targetType: "SloDefinition", targetId: row.id,
      metadata: { name, endpoint, objectiveType, targetPct: target },
    })
    res.status(200).json({ slo: row })
  } catch (err) { next(err) }
}

export async function deleteSlo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.sloDefinition.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "slo.delete", targetType: "SloDefinition", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Synthetic monitors -----------------------------------------------

export async function listMonitors(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.syntheticMonitor.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] })
    const failingCount = data.filter(m => m.enabled && m.lastOutcome === "fail").length
    res.status(200).json({ data, failingCount, runnerNote: "Note: this schedule is persisted but no in-process runner exists. Wire a worker (or use an external probe service) that POSTs results to /admin/observability/monitors/:id/record." })
  } catch (err) { next(err) }
}

export async function upsertMonitor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = typeof req.params.id === "string" ? req.params.id : undefined
    const { name, url, method, expectedStatus, expectedBodyContains, intervalSeconds, enabled } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim()) throw badRequest("name required")
    if (typeof url  !== "string" || !url.trim())  throw badRequest("url required")
    const data = {
      name: name.trim(), url: url.trim(),
      method:               typeof method === "string" ? method : "GET",
      expectedStatus:       Number(expectedStatus) || 200,
      expectedBodyContains: typeof expectedBodyContains === "string" ? expectedBodyContains : null,
      intervalSeconds:      Number(intervalSeconds) || 300,
      enabled:              enabled !== false,
    }
    const row = id
      ? await prisma.syntheticMonitor.update({ where: { id }, data })
      : await prisma.syntheticMonitor.create({ data: { ...data, createdBy: actorId } })
    await adminAuditR(req, res, {
      action: id ? "monitor.update" : "monitor.create", targetType: "SyntheticMonitor", targetId: row.id,
      metadata: { name, url },
    })
    res.status(200).json({ monitor: row })
  } catch (err) { next(err) }
}

export async function deleteMonitor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.syntheticMonitor.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "monitor.delete", targetType: "SyntheticMonitor", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function recordMonitorOutcome(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const { outcome, latencyMs, error } = req.body as Record<string, unknown>
    if (outcome !== "ok" && outcome !== "fail" && outcome !== "timeout") throw badRequest('outcome ∈ "ok"|"fail"|"timeout"')
    const monitor = await prisma.syntheticMonitor.findUnique({ where: { id } })
    if (!monitor) throw notFound("Monitor not found")
    const updated = await prisma.syntheticMonitor.update({
      where: { id },
      data: {
        lastRunAt:     new Date(),
        lastOutcome:   outcome,
        lastLatencyMs: typeof latencyMs === "number" ? latencyMs : null,
        lastError:     typeof error === "string" ? error : null,
      },
    })
    res.status(200).json({ monitor: updated })
  } catch (err) { next(err) }
}
