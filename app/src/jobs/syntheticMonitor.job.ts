import { prisma } from "../config/prisma"
import { recordLog } from "../lib/logSink"

/**
 * Runs every enabled SyntheticMonitor whose `lastRunAt + intervalSeconds`
 * is in the past. One probe per monitor per tick. Probe timeout = 10s.
 *
 * Recording the outcome flips `lastOutcome`, `lastLatencyMs`, `lastError`
 * so the admin UI lights up red without any extra wiring.
 */

const PROBE_TIMEOUT_MS = 10_000

export async function runSyntheticMonitors(): Promise<{ ran: number; failed: number }> {
  const now = Date.now()
  const candidates = await prisma.syntheticMonitor.findMany({ where: { enabled: true } })
  const due = candidates.filter(m => {
    if (!m.lastRunAt) return true
    return now - m.lastRunAt.getTime() >= m.intervalSeconds * 1000
  })

  let ran = 0, failed = 0
  await Promise.all(due.map(async (m) => {
    const start = Date.now()
    let outcome: "ok" | "fail" | "timeout" = "fail"
    let latencyMs = 0
    let error: string | null = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      const r = await fetch(m.url, { method: m.method, signal: controller.signal })
      clearTimeout(timer)
      latencyMs = Date.now() - start
      if (r.status !== m.expectedStatus) {
        outcome = "fail"
        error = `expected status ${m.expectedStatus}, got ${r.status}`
      } else if (m.expectedBodyContains) {
        const body = await r.text()
        if (!body.includes(m.expectedBodyContains)) {
          outcome = "fail"
          error = `body did not contain "${m.expectedBodyContains}"`
        } else {
          outcome = "ok"
        }
      } else {
        outcome = "ok"
      }
    } catch (err) {
      latencyMs = Date.now() - start
      outcome = (err as Error).name === "AbortError" ? "timeout" : "fail"
      error = (err as Error).message
    }

    if (outcome !== "ok") {
      failed++
      recordLog("warn", `[synthetic] monitor "${m.name}" → ${outcome}: ${error ?? ""}`, {
        attributes: { url: m.url, outcome, latencyMs, monitorId: m.id },
      })
    }
    ran++

    await prisma.syntheticMonitor.update({
      where: { id: m.id },
      data:  { lastRunAt: new Date(), lastOutcome: outcome, lastLatencyMs: latencyMs, lastError: error },
    }).catch(() => undefined)
  }))

  return { ran, failed }
}
