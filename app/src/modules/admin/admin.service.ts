import { prisma } from "../../config/prisma";
import { Prisma } from "../../generated/prisma/client";
import { notFound, badRequest } from "../../lib/errors";
import { auditMod, recordSecurityEvent } from "../../lib/audit";
import {
  broadcastAdminUserBan,
  broadcastAdminUserRole,
  broadcastAdminReportResolved,
} from "../../realtime/broadcast";

// ─── getStats ─────────────────────────────────────────────────────────────────

export async function getStats() {
  const [users, posts, anime, clubs, reviews, blogs] = await prisma.$transaction([
    prisma.user.count(),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.anime.count(),
    prisma.club.count(),
    prisma.review.count(),
    prisma.blog.count(),
  ]);

  return { users, posts, anime, clubs, reviews, blogs };
}

// ─── getRecentUsers ───────────────────────────────────────────────────────────

export async function getRecentUsers(limit = 20) {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      role: true,
      reputation: true,
      isBanned: true,
      createdAt: true,
    },
  });

  return { users, count: users.length };
}

// ─── listUsers (paginated, searchable) ────────────────────────────────────────

export async function listUsers(opts: {
  search?: string
  role?: "USER" | "MOD" | "ADMIN"
  banned?: boolean
  page: number
  limit: number
}) {
  const where: Prisma.UserWhereInput = {}
  if (opts.role !== undefined)   where.role = opts.role
  if (opts.banned !== undefined) where.isBanned = opts.banned
  if (opts.search) {
    where.OR = [
      { username:    { contains: opts.search, mode: "insensitive" } },
      { displayName: { contains: opts.search, mode: "insensitive" } },
      { email:       { contains: opts.search, mode: "insensitive" } },
    ]
  }

  const skip = (opts.page - 1) * opts.limit
  const [data, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: opts.limit,
      select: {
        id: true, username: true, displayName: true, email: true,
        role: true, reputation: true, isBanned: true,
        avatarUrl: true, createdAt: true,
        verifiedKind: true, verifiedAt: true,
        _count: { select: { posts: true, followers: true, following: true } },
      },
    }),
    prisma.user.count({ where }),
  ])

  return { data, meta: { total, page: opts.page, limit: opts.limit, pages: Math.ceil(total / opts.limit) } }
}

// ─── getUserDetail ────────────────────────────────────────────────────────────

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, displayName: true, email: true,
      role: true, reputation: true, isBanned: true, bannedReason: true,
      avatarUrl: true, createdAt: true, updatedAt: true,
      _count: { select: { posts: true, postComments: true, followers: true, following: true, blogs: true, reviews: true } },
    },
  })
  if (!user) throw notFound("User not found")

  const recentPosts = await prisma.post.findMany({
    where: { authorId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, content: true, createdAt: true, _count: { select: { likes: true, comments: true } } },
  })

  const recentSessions = await prisma.refreshToken.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    take: 5,
    select: { ipAddress: true, userAgent: true, lastUsedAt: true, createdAt: true },
  })

  return { user, recentPosts, recentSessions }
}

// ─── setUserBan ───────────────────────────────────────────────────────────────

export async function setUserBan(opts: {
  actorId: string
  userId: string
  banned: boolean
  reason?: string | null
}) {
  if (opts.actorId === opts.userId) throw badRequest("You cannot ban your own account")

  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { role: true, isBanned: true },
  })
  if (!user) throw notFound("User not found")
  if (user.role === "ADMIN") throw badRequest("Cannot ban another admin")

  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data:  { isBanned: opts.banned, bannedReason: opts.banned ? opts.reason ?? null : null },
    select: { id: true, username: true, isBanned: true, bannedReason: true },
  })

  // When banning, revoke every active session so the user is kicked out
  if (opts.banned) {
    await prisma.refreshToken.deleteMany({ where: { userId: opts.userId } })
  }

  auditMod("mod_action_applied", {
    actorId:    opts.actorId,
    targetUserId: opts.userId,
    targetType: "User",
    targetId:   opts.userId,
    action:     opts.banned ? "ban" : "unban",
    note:       opts.reason ?? null,
  })

  broadcastAdminUserBan(opts.userId, opts.banned, opts.actorId)

  return { user: updated }
}

// ─── setUserRole ──────────────────────────────────────────────────────────────

export async function setUserRole(opts: {
  actorId: string
  userId: string
  role: "USER" | "MOD" | "ADMIN"
}) {
  if (opts.actorId === opts.userId) throw badRequest("You cannot change your own role")

  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { role: true, username: true },
  })
  if (!user) throw notFound("User not found")
  const previousRole = user.role

  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data:  { role: opts.role },
    select: { id: true, username: true, role: true },
  })

  auditMod("role_changed", {
    actorId:      opts.actorId,
    targetUserId: opts.userId,
    targetType:   "User",
    targetId:     opts.userId,
    action:       `set_role:${opts.role}`,
    extra:        { previousRole },
  })

  broadcastAdminUserRole(opts.userId, opts.role, opts.actorId)

  return { user: updated }
}

// ─── listAuditLog ─────────────────────────────────────────────────────────────

export async function listAuditLog(opts: {
  type?: string
  userId?: string
  page: number
  limit: number
}) {
  const where: Prisma.SecurityEventWhereInput = {}
  if (opts.type)   where.type   = opts.type
  if (opts.userId) where.userId = opts.userId

  const skip = (opts.page - 1) * opts.limit
  const [data, total] = await prisma.$transaction([
    prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: opts.limit,
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    }),
    prisma.securityEvent.count({ where }),
  ])
  return { data, meta: { total, page: opts.page, limit: opts.limit, pages: Math.ceil(total / opts.limit) } }
}

// ─── getMetricsOverview ───────────────────────────────────────────────────────

/**
 * Headline numbers for the admin overview page. Cheap to compute against
 * existing indexes (createdAt + composite); intended for caching at 60s
 * once we have meaningful traffic.
 */
export async function getMetricsOverview() {
  const now    = new Date()
  const ms     = 24 * 60 * 60 * 1000
  const day1   = new Date(now.getTime() -  1 * ms)
  const day7   = new Date(now.getTime() -  7 * ms)
  const day30  = new Date(now.getTime() - 30 * ms)

  const [
    usersTotal,
    usersLast7d,
    usersLast30d,
    postsTotal,
    postsLast7d,
    activitiesLast7d,
    openReports,
    bannedUsers,
  ] = await prisma.$transaction([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: day7 } } }),
    prisma.user.count({ where: { createdAt: { gte: day30 } } }),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.post.count({ where: { deletedAt: null, createdAt: { gte: day7 } } }),
    prisma.activity.count({ where: { deletedAt: null, createdAt: { gte: day7 } } }),
    prisma.report.count({ where: { status: "OPEN" } }),
    prisma.user.count({ where: { isBanned: true } }),
  ])

  // Active users proxy: distinct authors in last-24h posts. groupBy can't run
  // inside the $transaction array above so we issue it separately.
  const activeAuthors = await prisma.post.groupBy({
    by:    ["authorId"],
    where: { deletedAt: null, createdAt: { gte: day1 } },
  })
  const activeUsersLast24h = activeAuthors.length

  // Signup chart — last 14 days, day-by-day
  const signupChartRaw = await prisma.$queryRaw<Array<{ day: Date, count: bigint }>>`
    SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS count
    FROM "User"
    WHERE "createdAt" >= ${new Date(now.getTime() - 14 * ms)}
    GROUP BY 1
    ORDER BY 1 ASC
  `
  const signupChart = signupChartRaw.map((r) => ({
    day:   r.day.toISOString().slice(0, 10),
    count: Number(r.count),
  }))

  return {
    users: {
      total: usersTotal,
      last7d: usersLast7d,
      last30d: usersLast30d,
      banned: bannedUsers,
    },
    content: {
      postsTotal,
      postsLast7d,
      activitiesLast7d,
    },
    engagement: {
      activeUsersLast24h,
    },
    moderation: {
      openReports,
    },
    signupChart,
    generatedAt: now.toISOString(),
  }
}

// ─── getTimeSeries ────────────────────────────────────────────────────────────

/**
 * Daily counts for the major event types over a configurable window.
 * Returns a row per day for the whole range (zero-filled) so the chart
 * doesn't have gaps. Used by the enterprise overview tile.
 */
export async function getTimeSeries(opts: { days: number }) {
  const days = Math.min(180, Math.max(1, Math.floor(opts.days || 30)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = await prisma.$queryRaw<Array<{
    day: Date
    signups:    bigint
    posts:      bigint
    activities: bigint
    likes:      bigint
    comments:   bigint
  }>>`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${since}::timestamptz),
        date_trunc('day', NOW()),
        '1 day'::interval
      )::date AS day
    )
    SELECT
      d.day,
      COALESCE((SELECT COUNT(*) FROM "User"        WHERE date_trunc('day', "createdAt") = d.day), 0)::bigint AS signups,
      COALESCE((SELECT COUNT(*) FROM "Post"        WHERE date_trunc('day', "createdAt") = d.day AND "deletedAt" IS NULL), 0)::bigint AS posts,
      COALESCE((SELECT COUNT(*) FROM "Activity"    WHERE date_trunc('day', "createdAt") = d.day AND "deletedAt" IS NULL), 0)::bigint AS activities,
      COALESCE((SELECT COUNT(*) FROM "PostLike"    WHERE date_trunc('day', "createdAt"::timestamptz) = d.day), 0)::bigint AS likes,
      COALESCE((SELECT COUNT(*) FROM "PostComment" WHERE date_trunc('day', "createdAt") = d.day), 0)::bigint AS comments
    FROM days d
    ORDER BY d.day
  `

  return rows.map(r => ({
    day:        r.day.toISOString().slice(0, 10),
    signups:    Number(r.signups),
    posts:      Number(r.posts),
    activities: Number(r.activities),
    likes:      Number(r.likes),
    comments:   Number(r.comments),
  }))
}

// ─── getTopPerformers ─────────────────────────────────────────────────────────

export async function getTopPerformers(opts: { days: number }) {
  const days = Math.min(180, Math.max(1, Math.floor(opts.days || 7)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [topUsers, topPosts] = await Promise.all([
    prisma.user.findMany({
      orderBy: { reputation: "desc" },
      take: 10,
      select: {
        id: true, username: true, displayName: true, avatarUrl: true,
        reputation: true, role: true, isBanned: true, createdAt: true,
        _count: { select: { posts: true, followers: true } },
      },
    }),
    prisma.post.findMany({
      where:   { deletedAt: null, createdAt: { gte: since } },
      orderBy: { likes: { _count: "desc" } },
      take:    10,
      select: {
        id: true, content: true, createdAt: true,
        author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        _count: { select: { likes: true, comments: true } },
      },
    }),
  ])

  return {
    topUsers: topUsers.map(u => ({
      id:          u.id,
      username:    u.username,
      displayName: u.displayName,
      avatarUrl:   u.avatarUrl,
      reputation:  u.reputation,
      role:        u.role,
      isBanned:    u.isBanned,
      posts:       u._count.posts,
      followers:   u._count.followers,
    })),
    topPosts: topPosts.map(p => ({
      id:        p.id,
      content:   p.content.slice(0, 140),
      createdAt: p.createdAt.toISOString(),
      author:    p.author,
      likes:     p._count.likes,
      comments:  p._count.comments,
    })),
  }
}

// ─── getFunnel ────────────────────────────────────────────────────────────────

/**
 * Acquisition funnel: signups → users who posted at least once →
 * users who completed at least one anime → users active in last 7d.
 * Each stage is a strict subset of the previous one. Cheap counts.
 */
export async function getFunnel() {
  const day7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [signups, hasPosted, hasCompleted, activeRecent] = await prisma.$transaction([
    prisma.user.count(),
    prisma.user.count({
      where: { posts: { some: { deletedAt: null } } },
    }),
    prisma.user.count({
      where: { listEntries: { some: { status: "COMPLETED" } } },
    }),
    prisma.user.count({
      where: {
        OR: [
          { posts:      { some: { createdAt: { gte: day7 }, deletedAt: null } } },
          { activities: { some: { createdAt: { gte: day7 }, deletedAt: null } } },
        ],
      },
    }),
  ])

  return [
    { stage: "Signed up",        users: signups,      pct: 100 },
    { stage: "Posted at least 1", users: hasPosted,    pct: signups ? Math.round((hasPosted    / signups) * 100) : 0 },
    { stage: "Completed an anime", users: hasCompleted, pct: signups ? Math.round((hasCompleted / signups) * 100) : 0 },
    { stage: "Active in last 7d",  users: activeRecent, pct: signups ? Math.round((activeRecent / signups) * 100) : 0 },
  ]
}

// ─── getSystemMetrics ─────────────────────────────────────────────────────────

/**
 * Cheap system snapshot. Real CPU/memory live in CloudWatch — surface
 * just what the API can compute itself: DB latency, in-process memory,
 * uptime, total event counts.
 */
export async function getSystemMetrics() {
  const start = Date.now()
  let dbStatus = "ok"
  let dbLatencyMs = 0
  try {
    await prisma.$queryRaw`SELECT 1`
    dbLatencyMs = Date.now() - start
  } catch {
    dbStatus = "error"
  }

  // 10 sequential pings to compute a rough p50/p99 — cheap, runs in ms
  const samples: number[] = []
  for (let i = 0; i < 10; i++) {
    const t = Date.now()
    try { await prisma.$queryRaw`SELECT 1` } catch { /* ignore */ }
    samples.push(Date.now() - t)
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? samples[samples.length - 1]

  const mem = process.memoryUsage()

  return {
    db: {
      status:    dbStatus,
      latencyMs: dbLatencyMs,
      p50,
      p99,
    },
    process: {
      uptimeSec: Math.floor(process.uptime()),
      rssMB:     Math.round(mem.rss        / 1024 / 1024),
      heapMB:    Math.round(mem.heapUsed   / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      node:      process.version,
    },
    ts: new Date().toISOString(),
  }
}

// ─── listReports ──────────────────────────────────────────────────────────────

export async function listReports(page = 1, limit = 20, status?: string) {
  const skip = (page - 1) * limit
  const where = status ? { status: status as import("../../generated/prisma/client").ReportStatus } : {}
  const [data, total] = await prisma.$transaction([
    prisma.report.findMany({
      where,
      include: { reporter: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      skip, take: limit,
    }),
    prisma.report.count({ where }),
  ])
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } }
}

// ─── resolveReport ────────────────────────────────────────────────────────────

export async function resolveReport(reportId: string, status: "RESOLVED" | "DISMISSED", modId: string) {
  const report = await prisma.report.update({
    where: { id: reportId },
    data: { status },
  })
  await prisma.moderationAction.create({
    data: { modId, targetType: "report", targetId: reportId, action: status.toLowerCase() },
  })
  auditMod("report_resolved", {
    actorId:    modId,
    targetType: "Report",
    targetId:   reportId,
    action:     status.toLowerCase(),
  })

  broadcastAdminReportResolved(reportId, status, modId)

  return { report }
}

// ─── getPlatformHealth ────────────────────────────────────────────────────────

export async function getPlatformHealth() {
  const start = Date.now();
  let dbStatus = "ok";
  let dbLatencyMs = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = "error";
  }

  const [users, posts, anime, clubs, reviews, blogs] = await prisma.$transaction([
    prisma.user.count(),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.anime.count(),
    prisma.club.count(),
    prisma.review.count(),
    prisma.blog.count(),
  ]);

  return {
    uptime: Math.floor(process.uptime()),
    db: { status: dbStatus, latencyMs: dbLatencyMs },
    totals: { users, posts, anime, clubs, reviews, blogs },
    deploy: {
      commit: process.env.RENDER_GIT_COMMIT ?? process.env.AWS_APP_RUNNER_REVISION ?? "dev",
      env:    process.env.NODE_ENV ?? "development",
    },
    ts: new Date().toISOString(),
  };
}

// Re-export so the controller can call recordSecurityEvent for ad-hoc admin actions
export { recordSecurityEvent }
