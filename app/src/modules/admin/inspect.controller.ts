import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { computeUserRisk } from "../../lib/riskScore"
import { isIpBlocked } from "../../lib/loginGuard"

/**
 * Forensic inspection endpoints. Lets operators trace an IP, score a
 * user's risk, find sock-puppet candidates, and search across every
 * recorded event from one input.
 *
 * Every read here exposes PII (IPs, emails, behavior history), so all
 * are audited as `inspect.*` events.
 */

// ── Risk score for a single user ─────────────────────────────────────────
export async function getUserRisk(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string
    const breakdown = await computeUserRisk(userId)
    await adminAuditR(req, res, {
      action: "inspect.user_risk_viewed", targetType: "User", targetId: userId,
      metadata: { score: breakdown.score, level: breakdown.level },
    })
    res.status(200).json(breakdown)
  } catch (err) { next(err) }
}

// ── IP forensics ────────────────────────────────────────────────────────
export async function getIpDossier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = req.params.ip as string
    if (!ip) throw badRequest("ip required")

    const [block, eventsByUser, refreshTokens, blockedRow] = await Promise.all([
      isIpBlocked(ip),
      prisma.securityEvent.findMany({
        where: { ipAddress: ip },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { user: { select: { id: true, email: true, username: true, displayName: true, isBanned: true, role: true } } },
      }),
      prisma.refreshToken.findMany({
        where:   { ipAddress: ip },
        include: { user: { select: { id: true, email: true, username: true } } },
        take:    50,
      }),
      prisma.ipBlock.findUnique({ where: { ip } }),
    ])

    // Build per-user rollup so we can show "this IP was used by these N accounts"
    const byUser = new Map<string, {
      user: { id: string; email: string; username: string; displayName: string; isBanned: boolean; role: string }
      events: number
      lastSeen: Date
      types: Record<string, number>
    }>()
    for (const e of eventsByUser) {
      if (!e.user) continue
      const rec = byUser.get(e.user.id)
      if (rec) {
        rec.events++
        rec.types[e.type] = (rec.types[e.type] ?? 0) + 1
        if (e.createdAt > rec.lastSeen) rec.lastSeen = e.createdAt
      } else {
        byUser.set(e.user.id, {
          user: e.user, events: 1, lastSeen: e.createdAt,
          types: { [e.type]: 1 },
        })
      }
    }

    await adminAuditR(req, res, {
      action: "inspect.ip_viewed", metadata: { ip, events: eventsByUser.length, distinctUsers: byUser.size },
    })

    res.status(200).json({
      ip,
      block:          blockedRow,
      currentBlocked: block.blocked,
      summary: {
        totalEvents:     eventsByUser.length,
        distinctUsers:   byUser.size,
        activeSessions:  refreshTokens.length,
      },
      users:           Array.from(byUser.values()).sort((a, b) => b.events - a.events),
      recentEvents:    eventsByUser.slice(0, 50),
      activeSessions:  refreshTokens,
    })
  } catch (err) { next(err) }
}

// ── Sock-puppet detection ────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0) return n; if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
    }
  }
  return dp[m][n]
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / max
}

export async function findSimilarAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, username: true },
    })
    if (!target) throw notFound("User not found")

    // Pull a broad-but-bounded candidate set: anyone with the same email
    // domain OR same first 3 letters of username. Then compute similarity
    // in process. This is a pragmatic compromise — full N×N would be huge.
    const emailDomain = target.email.split("@")[1] ?? ""
    const usernamePrefix = target.username.slice(0, 3).toLowerCase()
    const candidates = await prisma.user.findMany({
      where: {
        id: { not: userId },
        OR: [
          { email:    { endsWith: `@${emailDomain}`, mode: "insensitive" } },
          { username: { startsWith: usernamePrefix,  mode: "insensitive" } },
        ],
      },
      select: { id: true, email: true, username: true, displayName: true, isBanned: true, createdAt: true },
      take:   200,
    })

    const scored = candidates.map(c => ({
      ...c,
      usernameSim: similarity(c.username, target.username),
      emailSim:    similarity(c.email,    target.email),
      sharedDomain: c.email.split("@")[1] === emailDomain,
    }))
    .filter(c => c.usernameSim >= 0.7 || c.emailSim >= 0.7)
    .sort((a, b) => Math.max(b.usernameSim, b.emailSim) - Math.max(a.usernameSim, a.emailSim))
    .slice(0, 30)

    await adminAuditR(req, res, {
      action: "inspect.similar_users_viewed", targetType: "User", targetId: userId,
      metadata: { candidates: candidates.length, matches: scored.length },
    })
    res.status(200).json({ target, candidates: scored })
  } catch (err) { next(err) }
}

// ── Unified search across audit + security + users + ip blocks ───────────
export async function inspectSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
    if (q.length < 2) {
      res.status(200).json({ q, results: { users: [], auditLogs: [], securityEvents: [], ipBlocks: [] } })
      return
    }
    const like = { contains: q, mode: "insensitive" as const }

    const [users, auditLogs, securityEvents, ipBlocks] = await Promise.all([
      prisma.user.findMany({
        where:  { OR: [{ email: like }, { username: like }, { displayName: like }, { id: q }] },
        select: { id: true, email: true, username: true, displayName: true, isBanned: true, role: true, createdAt: true },
        take: 20,
      }),
      prisma.auditLog.findMany({
        where:  { OR: [{ action: like }, { actorId: q }, { targetId: q }, { ipAddress: q }] },
        orderBy:{ createdAt: "desc" },
        take: 20,
      }),
      prisma.securityEvent.findMany({
        where:  { OR: [{ type: like }, { userId: q }, { ipAddress: q }] },
        orderBy:{ createdAt: "desc" },
        include: { user: { select: { id: true, username: true, email: true } } },
        take: 20,
      }),
      prisma.ipBlock.findMany({
        where:  { ip: like },
        take: 20,
      }),
    ])

    await adminAuditR(req, res, {
      action: "inspect.search", metadata: { q, hits: users.length + auditLogs.length + securityEvents.length + ipBlocks.length },
    })

    res.status(200).json({ q, results: { users, auditLogs, securityEvents, ipBlocks } })
  } catch (err) { next(err) }
}

// ── IP block CRUD (manual + listing) ─────────────────────────────────────
export async function listIpBlocks(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.ipBlock.findMany({
      where:   { expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take:    200,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function manualBlockIp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { ip, reason, ttlMinutes } = req.body as { ip?: string; reason?: string; ttlMinutes?: number }
    if (!ip) throw badRequest("ip required")
    const ttl = typeof ttlMinutes === "number" && ttlMinutes > 0 ? ttlMinutes : 60
    const expiresAt = new Date(Date.now() + ttl * 60_000)
    const row = await prisma.ipBlock.upsert({
      where:  { ip },
      update: { reason: reason ?? "manual", blockedBy: actorId, expiresAt },
      create: { ip, reason: reason ?? "manual", blockedBy: actorId, expiresAt },
    })
    await adminAuditR(req, res, {
      action: "security.ip_blocked", targetType: "IpBlock", targetId: ip,
      metadata: { reason, ttlMinutes: ttl },
    })
    res.status(200).json(row)
  } catch (err) { next(err) }
}

export async function unblockIp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = req.params.ip as string
    await prisma.ipBlock.delete({ where: { ip } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "security.ip_unblocked", targetType: "IpBlock", targetId: ip })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
