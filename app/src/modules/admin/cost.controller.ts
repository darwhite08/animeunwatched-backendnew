import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

/**
 * Multiplies request volume from EndpointStat by the per-endpoint cost
 * rate to produce a cost dashboard. Cost is stored as 1/100ths of a cent
 * so we can express fractions of a cent (e.g. a $0.0001 request = 1 unit).
 *
 * No real-time billing — this is observability for ops, not invoicing.
 */

const CENT_HUNDREDTHS_PER_DOLLAR = 100 * 100   // $1 = 10000

function unitsToDollars(units: bigint | number): number {
  return Number(units) / CENT_HUNDREDTHS_PER_DOLLAR
}

export async function getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 7))
    const since = new Date(Date.now() - days * 24 * 60 * 60_000)

    const [stats, rates, budget] = await Promise.all([
      prisma.endpointStat.findMany({
        where: { hourBucket: { gte: since } },
      }),
      prisma.costRate.findMany(),
      prisma.costBudget.findUnique({ where: { scope: "global" } }),
    ])
    const rateByEndpoint = new Map(rates.map(r => [r.endpoint, r]))

    interface Row {
      endpoint: string; category: string | null
      requests: number; errors: number
      centsPer1k: number
      costUnits: number          // sum of (requests / 1000) * centsPer1k, kept as plain Number; precision is fine for dashboards
    }
    const rowsMap = new Map<string, Row>()
    for (const s of stats) {
      const rate = rateByEndpoint.get(s.endpoint)
      const cents = rate?.centsPer1k ?? 0
      const row = rowsMap.get(s.endpoint) ?? {
        endpoint: s.endpoint, category: rate?.category ?? null,
        requests: 0, errors: 0, centsPer1k: cents, costUnits: 0,
      }
      row.requests += s.requests
      row.errors   += s.errors
      row.costUnits += (s.requests / 1000) * cents
      rowsMap.set(s.endpoint, row)
    }

    const endpoints = Array.from(rowsMap.values())
      .map(r => ({
        ...r,
        costDollars: unitsToDollars(r.costUnits),
      }))
      .sort((a, b) => b.costUnits - a.costUnits)

    const totalUnits   = endpoints.reduce((s, r) => s + r.costUnits, 0)
    const totalReq     = endpoints.reduce((s, r) => s + r.requests, 0)
    const totalDollars = unitsToDollars(totalUnits)

    // Per-category rollup for the pie/legend
    const catMap = new Map<string, { category: string; costUnits: number; requests: number }>()
    for (const r of endpoints) {
      const key = r.category ?? "uncategorized"
      const c = catMap.get(key) ?? { category: key, costUnits: 0, requests: 0 }
      c.costUnits += r.costUnits
      c.requests  += r.requests
      catMap.set(key, c)
    }
    const categories = Array.from(catMap.values()).map(c => ({ ...c, costDollars: unitsToDollars(c.costUnits) })).sort((a, b) => b.costUnits - a.costUnits)

    // Budget alert calc
    let budgetState: { pctUsed: number; status: "ok" | "warn" | "over" } | null = null
    if (budget) {
      const pct = Number(budget.monthlyBudgetCents) > 0
        ? Math.min(999, (totalUnits / Number(budget.monthlyBudgetCents)) * 100)
        : 0
      budgetState = {
        pctUsed: +pct.toFixed(2),
        status:  pct >= 100 ? "over" : pct >= budget.alertAtPct ? "warn" : "ok",
      }
    }

    res.status(200).json({
      windowDays: days,
      totalRequests: totalReq,
      totalCostDollars: +totalDollars.toFixed(4),
      endpoints,
      categories,
      budget: budget ? {
        monthlyBudgetDollars: unitsToDollars(budget.monthlyBudgetCents),
        alertAtPct: budget.alertAtPct,
        ...budgetState!,
      } : null,
    })
  } catch (err) { next(err) }
}

export async function listRates(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.costRate.findMany({ orderBy: { endpoint: "asc" } })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertRate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { endpoint, centsPer1k, category, notes } = req.body as Record<string, unknown>
    if (typeof endpoint !== "string" || !endpoint.trim()) throw badRequest("endpoint required")
    const cents = Number(centsPer1k)
    if (!Number.isFinite(cents) || cents < 0)             throw badRequest("centsPer1k must be a non-negative number")

    const row = await prisma.costRate.upsert({
      where:  { endpoint },
      update: {
        centsPer1k: Math.round(cents),
        category:   typeof category === "string" ? category : null,
        notes:      typeof notes    === "string" ? notes    : null,
        updatedBy:  actorId,
      },
      create: {
        endpoint, centsPer1k: Math.round(cents),
        category: typeof category === "string" ? category : null,
        notes:    typeof notes    === "string" ? notes    : null,
        updatedBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "cost.rate.upsert", targetType: "CostRate", targetId: row.id,
      metadata: { endpoint, centsPer1k: row.centsPer1k },
    })
    res.status(200).json({ rate: row })
  } catch (err) { next(err) }
}

export async function deleteRate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.costRate.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "cost.rate.delete", targetType: "CostRate", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function getBudget(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const b = await prisma.costBudget.findUnique({ where: { scope: "global" } })
    if (!b) { res.status(200).json({ budget: null }); return }
    res.status(200).json({
      budget: {
        ...b,
        monthlyBudgetDollars: unitsToDollars(b.monthlyBudgetCents),
        monthlyBudgetCents: undefined,   // hide raw bigint from the wire
      },
    })
  } catch (err) { next(err) }
}

export async function setBudget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { monthlyBudgetDollars, alertAtPct } = req.body as Record<string, unknown>
    const dollars = Number(monthlyBudgetDollars)
    if (!Number.isFinite(dollars) || dollars < 0) throw badRequest("monthlyBudgetDollars must be non-negative")
    const units = BigInt(Math.round(dollars * CENT_HUNDREDTHS_PER_DOLLAR))
    const pct = Number(alertAtPct)
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) throw badRequest("alertAtPct must be 1..100")

    const row = await prisma.costBudget.upsert({
      where:  { scope: "global" },
      update: { monthlyBudgetCents: units, alertAtPct: Math.round(pct) },
      create: { scope: "global", monthlyBudgetCents: units, alertAtPct: Math.round(pct) },
    })
    await adminAuditR(req, res, {
      action: "cost.budget.set", targetType: "CostBudget", targetId: row.id,
      metadata: { monthlyBudgetDollars: dollars, alertAtPct: row.alertAtPct },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
