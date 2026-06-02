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
