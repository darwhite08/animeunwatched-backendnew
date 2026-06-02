import { prisma } from "../config/prisma"

/**
 * Log sink that persists WARN+ entries into Postgres so the admin UI can
 * search recent failures without external log infra.
 *
 * Buffered + flushed every 2 seconds (or when the buffer hits 50 entries)
 * so we don't make a DB round-trip per log line. Verbose levels stay on
 * stdout — querying high-volume logs out of Postgres is a bad idea above
 * hobby scale.
 *
 * Use `recordLog(level, message, attrs)` from anywhere; the pino transport
 * (logger.ts) also funnels through here.
 */

interface BufferedEntry {
  level: "warn" | "error" | "fatal"
  message: string
  requestId?: string
  traceId?: string
  attributes?: Record<string, unknown>
  createdAt: Date
}

const BUFFER: BufferedEntry[] = []
const MAX_BUFFER = 50
const FLUSH_MS   = 2_000

let flushTimer: NodeJS.Timeout | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; void flushLogs() }, FLUSH_MS)
}

export async function flushLogs(): Promise<{ flushed: number }> {
  if (BUFFER.length === 0) return { flushed: 0 }
  const batch = BUFFER.splice(0, BUFFER.length)
  try {
    await prisma.logEntry.createMany({
      data: batch.map(e => ({
        level: e.level, message: e.message,
        requestId: e.requestId ?? null,
        traceId:   e.traceId   ?? null,
        attributes: (e.attributes ?? null) as never,
        createdAt: e.createdAt,
      })),
    })
    return { flushed: batch.length }
  } catch (err) {
    // Don't re-enqueue — if Postgres is down we'd loop forever. Drop + complain to stdout.
    console.error("[logSink] flush failed, dropping batch:", err)
    return { flushed: 0 }
  }
}

export function recordLog(
  level: "warn" | "error" | "fatal",
  message: string,
  meta?: { requestId?: string; traceId?: string; attributes?: Record<string, unknown> },
): void {
  BUFFER.push({
    level, message,
    requestId:  meta?.requestId,
    traceId:    meta?.traceId,
    attributes: meta?.attributes,
    createdAt:  new Date(),
  })
  if (BUFFER.length >= MAX_BUFFER) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    void flushLogs()
  } else {
    scheduleFlush()
  }
}

// Pino plug — wire pino-http's customLogLevel/customSuccessMessage to call
// recordLog when level === "warn" | "error" | "fatal". Done in logger.ts.
