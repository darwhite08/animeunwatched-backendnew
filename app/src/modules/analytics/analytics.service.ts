import { prisma } from "../../config/prisma";

export async function getPlatformStats() {
  const [users, posts, anime, clubs, reviews, blogs, listEntries] = await prisma.$transaction([
    prisma.user.count(),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.anime.count(),
    prisma.club.count(),
    prisma.review.count(),
    prisma.blog.count({ where: { status: "PUBLISHED" } }),
    prisma.listEntry.count(),
  ]);
  return { users, posts, anime, clubs, reviews, blogs, listEntries, timestamp: new Date() };
}

export async function getTopAnime(limit = 10) {
  return prisma.anime.findMany({
    where: { score: { not: null } },
    orderBy: { score: "desc" },
    take: limit,
    select: { malId: true, title: true, score: true, imageUrl: true, type: true, year: true },
  });
}

export async function getReputationLeaderboard(limit = 20) {
  return prisma.user.findMany({
    where: { reputation: { gt: 0 } },
    orderBy: { reputation: "desc" },
    take: limit,
    select: { id: true, username: true, displayName: true, reputation: true, avatarUrl: true },
  })
}

export async function getRecentActivity(limit = 20) {
  const [posts, reviews] = await prisma.$transaction([
    prisma.post.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { author: { select: { username: true, displayName: true } } },
    }),
    prisma.review.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        author: { select: { username: true } },
        anime: { select: { title: true } },
      },
    }),
  ]);
  return { posts, reviews };
}
