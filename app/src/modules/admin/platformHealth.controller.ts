import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Composite "is everything OK?" answer. Pulls from the surfaces we already
 * persist and composes a single response:
 *
 *   overall: "operational" | "degraded" | "outage"
 *   signals: per-source breakdown with status + count + last-checked
 *
 * Drives a single admin page so on-call doesn't have to open 8 tabs.
 */

export async function getPlatformHealthOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = new Date()
    const last24h = new Date(Date.now() - 24 * 60 * 60_000)

    const [
      openIncidents,
      activeMaintenance,
      monitors,
      latestBackup,
      criticalAlertsUnacked,
      breachedSloCount,
      recentErrorRate,
    ] = await Promise.all([
      prisma.incident.findMany({ where: { status: { not: "resolved" } }, select: { id: true, severity: true, status: true, title: true, startedAt: true } }),
      prisma.maintenanceWindow.findMany({ where: { startsAt: { lte: now }, endsAt: { gte: now }, cancelledAt: null }, select: { id: true, title: true, scope: true, endsAt: true } }),
      prisma.syntheticMonitor.findMany({ where: { enabled: true }, select: { id: true, name: true, lastOutcome: true, lastLatencyMs: true, lastRunAt: true } }),
      prisma.backupRecord.findFirst({ where: { kind: "db" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
      prisma.adminAlert.count({ where: { severity: "critical", acknowledgedAt: null, createdAt: { gte: last24h } } }),
      computeSloBreaches(),
      computeRecentErrorRate(last24h),
    ])

    const failingMonitors = monitors.filter(m => m.lastOutcome === "fail" || m.lastOutcome === "timeout").length
    const overdueBackup   = !latestBackup || (now.getTime() - latestBackup.completedAt.getTime() > 24 * 60 * 60_000)
    const sev1Open        = openIncidents.some(i => i.severity === "sev1")
    const sev2Open        = openIncidents.some(i => i.severity === "sev2")

    const overall: "operational" | "degraded" | "outage" =
      sev1Open || overdueBackup || criticalAlertsUnacked > 0 ? "outage" :
      sev2Open || failingMonitors > 0 || breachedSloCount > 0 || recentErrorRate > 1 || activeMaintenance.length > 0 ? "degraded" :
      "operational"

    res.status(200).json({
      overall,
      generatedAt: now.toISOString(),
      signals: {
        incidents:        { open: openIncidents.length, sev1: openIncidents.filter(i => i.severity === "sev1").length, sev2: openIncidents.filter(i => i.severity === "sev2").length, list: openIncidents.slice(0, 5) },
        maintenance:      { active: activeMaintenance.length, list: activeMaintenance },
        synthetics:       { total: monitors.length, failing: failingMonitors, list: monitors.filter(m => m.lastOutcome !== "ok").slice(0, 5) },
        backups:          { dbLastAt: latestBackup?.completedAt ?? null, overdue: overdueBackup },
        alerts:           { unackedCritical: criticalAlertsUnacked },
        slos:             { breached: breachedSloCount },
        errors:           { lastDayErrorRatePct: +recentErrorRate.toFixed(2) },
      },
    })
  } catch (err) { next(err) }
}

async function computeSloBreaches(): Promise<number> {
  const slos = await prisma.sloDefinition.findMany()
  if (slos.length === 0) return 0
  let breached = 0
  for (const slo of slos) {
    const since = new Date(Date.now() - slo.windowDays * 24 * 60 * 60_000)
    const where: Record<string, unknown> = { hourBucket: { gte: since } }
    if (slo.endpoint !== "*") where.endpoint = slo.endpoint
    const stats = await prisma.endpointStat.findMany({ where })
    const totalReq = stats.reduce((s, r) => s + r.requests, 0)
    const totalErr = stats.reduce((s, r) => s + r.errors, 0)
    let actualPct = 100
    if (slo.objectiveType === "availability") {
      actualPct = totalReq === 0 ? 100 : ((totalReq - totalErr) / totalReq) * 100
    } else if (slo.objectiveType === "latency_p99" && slo.thresholdMs) {
      const passed = stats.filter(s => s.p99Ms <= (slo.thresholdMs ?? 0)).length
      actualPct = stats.length === 0 ? 100 : (passed / stats.length) * 100
    }
    if (actualPct < slo.targetPct) breached++
  }
  return breached
}

async function computeRecentErrorRate(since: Date): Promise<number> {
  const stats = await prisma.endpointStat.findMany({ where: { hourBucket: { gte: since } } })
  const totalReq = stats.reduce((s, r) => s + r.requests, 0)
  const totalErr = stats.reduce((s, r) => s + r.errors, 0)
  return totalReq === 0 ? 0 : (totalErr / totalReq) * 100
}
