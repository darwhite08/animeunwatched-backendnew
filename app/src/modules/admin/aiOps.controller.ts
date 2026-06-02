import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const CENTS_PER_DOLLAR = 10000  // 1/100ths of a cent

function unitsToDollars(u: number | bigint): number { return Number(u) / CENTS_PER_DOLLAR }

// ---- LLM call dashboard -----------------------------------------------

export async function getLlmOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 7))
    const since = new Date(Date.now() - days * 24 * 60 * 60_000)
    const calls = await prisma.llmCall.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" }, take: 10000,
    })

    const totalCost  = calls.reduce((s, c) => s + c.costCents, 0)
    const totalTokens = calls.reduce((s, c) => s + c.totalTokens, 0)
    const totalCalls = calls.length
    const errors     = calls.filter(c => c.status !== "ok").length
    const meanLatency = totalCalls > 0 ? Math.round(calls.reduce((s, c) => s + c.latencyMs, 0) / totalCalls) : 0

    // Group by model + by endpoint
    interface Agg { key: string; calls: number; cost: number; tokens: number; errors: number; meanLatency: number; totalLatency: number }
    function groupBy(field: "model" | "endpoint"): Agg[] {
      const map = new Map<string, Agg>()
      for (const c of calls) {
        const key = (c as Record<string, unknown>)[field] as string ?? "unknown"
        const a = map.get(key) ?? { key, calls: 0, cost: 0, tokens: 0, errors: 0, meanLatency: 0, totalLatency: 0 }
        a.calls++; a.cost += c.costCents; a.tokens += c.totalTokens
        a.totalLatency += c.latencyMs
        if (c.status !== "ok") a.errors++
        map.set(key, a)
      }
      return Array.from(map.values()).map(a => ({ ...a, meanLatency: a.calls > 0 ? Math.round(a.totalLatency / a.calls) : 0 })).sort((x, y) => y.cost - x.cost)
    }

    const recent = calls.slice(0, 50)

    res.status(200).json({
      windowDays: days,
      totals: {
        calls: totalCalls,
        errors,
        errorRatePct: totalCalls > 0 ? +(errors / totalCalls * 100).toFixed(2) : 0,
        costDollars: +unitsToDollars(totalCost).toFixed(4),
        tokens: totalTokens,
        meanLatencyMs: meanLatency,
      },
      byModel:    groupBy("model").map(g => ({ ...g, costDollars: unitsToDollars(g.cost) })),
      byEndpoint: groupBy("endpoint").map(g => ({ ...g, costDollars: unitsToDollars(g.cost) })),
      recent: recent.map(c => ({ id: c.id, model: c.model, endpoint: c.endpoint, status: c.status, totalTokens: c.totalTokens, costDollars: unitsToDollars(c.costCents), latencyMs: c.latencyMs, createdAt: c.createdAt })),
    })
  } catch (err) { next(err) }
}

// ---- Prompt registry --------------------------------------------------

export async function listPrompts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.promptVersion.findMany({ orderBy: [{ key: "asc" }, { version: "desc" }] })
    // Group by key, surface active version
    const byKey = new Map<string, { key: string; versions: typeof rows; active: typeof rows[number] | null }>()
    for (const r of rows) {
      const g = byKey.get(r.key) ?? { key: r.key, versions: [], active: null }
      g.versions.push(r)
      if (r.active) g.active = r
      byKey.set(r.key, g)
    }
    res.status(200).json({ data: Array.from(byKey.values()) })
  } catch (err) { next(err) }
}

export async function createPromptVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { key, template, description, activate } = req.body as Record<string, unknown>
    if (typeof key      !== "string" || !key.trim())      throw badRequest("key required")
    if (typeof template !== "string" || !template.trim()) throw badRequest("template required")
    const latest = await prisma.promptVersion.findFirst({ where: { key }, orderBy: { version: "desc" } })
    const nextVersion = latest ? latest.version + 1 : 1
    const created = await prisma.promptVersion.create({
      data: {
        key, version: nextVersion, template,
        description: typeof description === "string" ? description : null,
        active:      false,
        createdBy:   actorId,
      },
    })
    if (activate === true) {
      await prisma.$transaction([
        prisma.promptVersion.updateMany({ where: { key, active: true }, data: { active: false } }),
        prisma.promptVersion.update({ where: { id: created.id }, data: { active: true } }),
      ])
    }
    await adminAuditR(req, res, {
      action: "prompt.create", targetType: "PromptVersion", targetId: created.id,
      metadata: { key, version: nextVersion, activated: activate === true },
    })
    res.status(200).json({ promptVersion: created })
  } catch (err) { next(err) }
}

export async function activatePromptVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const pv = await prisma.promptVersion.findUnique({ where: { id } })
    if (!pv) throw notFound("Prompt version not found")
    await prisma.$transaction([
      prisma.promptVersion.updateMany({ where: { key: pv.key, active: true }, data: { active: false } }),
      prisma.promptVersion.update({ where: { id }, data: { active: true } }),
    ])
    await adminAuditR(req, res, {
      action: "prompt.activate", targetType: "PromptVersion", targetId: id,
      metadata: { key: pv.key, version: pv.version },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Eval results -----------------------------------------------------

export async function listEvals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const evalSet = typeof req.query.evalSet === "string" ? req.query.evalSet : undefined
    const data = await prisma.evalResult.findMany({
      where: evalSet ? { evalSet } : {},
      orderBy: { ranAt: "desc" }, take: 200,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createEval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { promptVersionId, evalSet, scoreOverall, scoresJson, sampleCount } = req.body as Record<string, unknown>
    if (typeof promptVersionId !== "string") throw badRequest("promptVersionId required")
    if (typeof evalSet         !== "string") throw badRequest("evalSet required")
    if (typeof scoreOverall    !== "number") throw badRequest("scoreOverall must be a number")
    if (typeof sampleCount     !== "number") throw badRequest("sampleCount must be a number")
    const created = await prisma.evalResult.create({
      data: {
        promptVersionId, evalSet, scoreOverall, sampleCount,
        scoresJson: (scoresJson ?? {}) as never,
        ranBy:      actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "eval.create", targetType: "EvalResult", targetId: created.id,
      metadata: { evalSet, score: scoreOverall },
    })
    res.status(200).json({ result: created })
  } catch (err) { next(err) }
}

// ---- RAG documents ----------------------------------------------------

export async function listRag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const collection = typeof req.query.collection === "string" ? req.query.collection : undefined
    const data = await prisma.ragDocument.findMany({
      where: collection ? { collection } : {},
      orderBy: { lastIndexedAt: "desc" }, take: 500,
    })
    const summary = new Map<string, { collection: string; docs: number; chunks: number; bytes: number }>()
    for (const d of data) {
      const s = summary.get(d.collection) ?? { collection: d.collection, docs: 0, chunks: 0, bytes: 0 }
      s.docs++; s.chunks += d.chunks; s.bytes += d.bytes
      summary.set(d.collection, s)
    }
    res.status(200).json({ data, summary: Array.from(summary.values()) })
  } catch (err) { next(err) }
}

export async function upsertRag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { collection, title, sourceUrl, contentHash, chunks, bytes } = req.body as Record<string, unknown>
    if (typeof collection  !== "string") throw badRequest("collection required")
    if (typeof title       !== "string") throw badRequest("title required")
    if (typeof contentHash !== "string") throw badRequest("contentHash required")
    const row = await prisma.ragDocument.upsert({
      where:  { collection_contentHash: { collection, contentHash } },
      update: {
        title, sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
        chunks: Number(chunks) || 0, bytes: Number(bytes) || 0,
        lastIndexedAt: new Date(),
      },
      create: {
        collection, title, contentHash,
        sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
        chunks: Number(chunks) || 0, bytes: Number(bytes) || 0,
      },
    })
    await adminAuditR(req, res, {
      action: "rag.upsert", targetType: "RagDocument", targetId: row.id,
      metadata: { collection, title },
    })
    res.status(200).json({ document: row })
  } catch (err) { next(err) }
}

export async function deleteRag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.ragDocument.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "rag.delete", targetType: "RagDocument", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
