import type { Request, Response, NextFunction } from "express"
import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * Self-hosted distributed-tracing capture. One root span per request,
 * sampled at TRACE_SAMPLE_PCT (default 10%). Nested spans are out of
 * scope for this iteration — they'd need a Prisma extension + fetch
 * wrapper.
 *
 * Spans are appended to res.locals.traceId so other middleware (the log
 * transport, error handler) can correlate.
 *
 * Honors incoming W3C traceparent header so an OTel-aware upstream can
 * preserve the trace ID for cross-service propagation in the future.
 */

const SAMPLE_PCT = Math.max(0, Math.min(100, Number(process.env.TRACE_SAMPLE_PCT ?? "10")))

function shouldSample(): boolean {
  return Math.random() * 100 < SAMPLE_PCT
}

function genHex(bytes: number): string { return crypto.randomBytes(bytes).toString("hex") }

function parseTraceparent(h: string | undefined): { traceId: string; parentSpanId: string } | null {
  if (!h) return null
  // 00-<32 hex traceId>-<16 hex spanId>-<flags>
  const m = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/i.exec(h.trim())
  if (!m) return null
  return { traceId: m[1].toLowerCase(), parentSpanId: m[2].toLowerCase() }
}

function endpointKey(req: Request): string {
  const route = (req.route as { path?: string } | undefined)?.path
  const base  = req.baseUrl ?? ""
  return `${req.method} ${route ? base + route : req.path}`
}

export function traceCapture() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sampled = shouldSample()
    const incoming = parseTraceparent(req.header("traceparent") ?? undefined)
    const traceId  = incoming?.traceId ?? genHex(16)
    const spanId   = genHex(8)
    ;(res.locals as Record<string, unknown>).traceId = traceId
    ;(res.locals as Record<string, unknown>).spanId  = spanId

    // Always set the response header so consumers can correlate even if we
    // didn't sample for persistence.
    res.setHeader("X-Trace-Id", traceId)

    if (!sampled) return next()

    const start = Date.now()
    res.on("finish", () => {
      const durationMs = Date.now() - start
      const userId = (res.locals as { user?: { id?: string } }).user?.id
      const attributes = {
        statusCode: res.statusCode,
        ip:         (req.header("X-Forwarded-For") ?? req.ip)?.toString().split(",")[0]?.trim() ?? null,
        userAgent:  req.header("User-Agent")?.slice(0, 200) ?? null,
        userId:     userId ?? null,
        requestId:  (res.locals as { requestId?: string }).requestId ?? null,
      }
      prisma.traceSpan.create({
        data: {
          traceId, spanId,
          parentSpanId: incoming?.parentSpanId ?? null,
          name:         endpointKey(req),
          kind:         "server",
          status:       res.statusCode >= 500 ? "error" : "ok",
          startedAt:    new Date(start),
          durationMs,
          attributes:   attributes as never,
        },
      }).catch((err) => console.error("[trace] persist failed:", err))
    })
    next()
  }
}
