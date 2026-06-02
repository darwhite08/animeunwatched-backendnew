/**
 * Self-hosted realtime analytics — an in-memory ring buffer of recent
 * page-view pings. Lightweight enough to run on a single backend instance
 * up to ~1k pageviews/min before it makes sense to move to Redis.
 *
 * Stored per-event: timestamp, anonymous visitor id (cookie-stable),
 * authenticated userId (optional), path. Nothing PII-sensitive.
 *
 * Snapshot exposed via getLiveSnapshot() — used both by the admin REST
 * endpoint and by the socket emitter that broadcasts to room "admin".
 */

interface PageviewEvent {
  ts:        number  // epoch ms
  visitorId: string  // anon, stable per browser
  userId:    string | null
  path:      string
}

const WINDOW_MS         = 30 * 60 * 1000  // 30 min sliding window
const ACTIVE_WINDOW_MS  = 5  * 60 * 1000  // "online now" definition
const MAX_BUFFERED      = 20_000           // hard cap; older events drop

const buffer: PageviewEvent[] = []

function prune(now = Date.now()): void {
  const cutoff = now - WINDOW_MS
  // Buffer is append-only and ordered; lop off the head until we're within window
  while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift()
  // Hard cap as a paranoia guard against bursts
  while (buffer.length > MAX_BUFFERED) buffer.shift()
}

export function recordPageview(opts: {
  visitorId: string
  userId?: string | null
  path:    string
}): void {
  if (!opts.visitorId || !opts.path) return
  buffer.push({
    ts:        Date.now(),
    visitorId: opts.visitorId.slice(0, 64),
    userId:    opts.userId ?? null,
    path:      opts.path.slice(0, 200),
  })
  prune()
}

export interface LiveSnapshot {
  activeVisitors: number   // distinct visitorId in last 5 min
  activeUsers:    number   // distinct logged-in userId in last 5 min
  pageviews30m:   number
  pageviews5m:    number
  topPaths: Array<{ path: string; count: number }>
  generatedAt:    number
}

export function getLiveSnapshot(): LiveSnapshot {
  const now = Date.now()
  prune(now)

  const activeCutoff = now - ACTIVE_WINDOW_MS
  const activeVisitors = new Set<string>()
  const activeUsers    = new Set<string>()
  const pathCounts     = new Map<string, number>()
  let pageviews5m = 0

  for (const e of buffer) {
    pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1)
    if (e.ts >= activeCutoff) {
      activeVisitors.add(e.visitorId)
      if (e.userId) activeUsers.add(e.userId)
      pageviews5m++
    }
  }

  const topPaths = Array.from(pathCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([path, count]) => ({ path, count }))

  return {
    activeVisitors: activeVisitors.size,
    activeUsers:    activeUsers.size,
    pageviews30m:   buffer.length,
    pageviews5m,
    topPaths,
    generatedAt:    now,
  }
}
