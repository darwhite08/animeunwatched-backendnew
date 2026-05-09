import { prisma } from "../../config/prisma";

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
    ts: new Date().toISOString(),
  };
}
