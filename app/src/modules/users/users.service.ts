import { prisma } from "../../config/prisma";
import { notFound, conflict } from "../../lib/errors";
import type { UpdateMeDto } from "./users.schema";

const safeUserSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  role: true,
  reputation: true,
  createdAt: true,
} as const;

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      ...safeUserSelect,
      _count: {
        select: {
          followers: true,
          following: true,
          listEntries: true,
          reviews: true,
        },
      },
      posts: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          content: true,
          animeId: true,
          createdAt: true,
        },
      },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          animeId: true,
          score: true,
          body: true,
          createdAt: true,
        },
      },
    },
  });

  if (!user) throw notFound("User not found");

  const { _count, posts, reviews, ...rest } = user;

  return {
    user: rest,
    stats: {
      followers: _count.followers,
      following: _count.following,
      listCount: _count.listEntries,
      reviewCount: _count.reviews,
    },
    recentPosts: posts,
    recentReviews: reviews,
  };
}

// ─── updateMe ─────────────────────────────────────────────────────────────────

export async function updateMe(userId: string, dto: UpdateMeDto) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
    },
    select: safeUserSelect,
  });
  return { user };
}

// ─── follow ───────────────────────────────────────────────────────────────────

export async function follow(followerId: string, targetUsername: string) {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw notFound("User not found");
  if (target.id === followerId) {
    throw conflict("You cannot follow yourself");
  }

  try {
    await prisma.follow.create({
      data: { followerId, followingId: target.id },
    });
  } catch (err: unknown) {
    // Prisma unique constraint violation
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      throw conflict("Already following this user");
    }
    throw err;
  }
}

// ─── calculateXp ──────────────────────────────────────────────────────────────

export function calculateXp(reputation: number): { xp: number; level: number; title: string; nextLevelXp: number } {
  const xp = reputation * 100
  const levels = [0, 500, 1500, 3000, 6000, 12000, 25000, 50000, 100000, 200000, 500000, 1000000]
  const titles = ["Neophyte","Initiate","Apprentice","Shinobi","Jonin","Anbu","Elite Jonin","Kage","Legendary","Arch-Mage","Shadow Watcher","Neural Oracle"]
  let level = 1
  for (let i = 1; i < levels.length; i++) {
    if (xp >= levels[i]) level = i + 1
    else break
  }
  return { xp, level, title: titles[level - 1] ?? "Legendary", nextLevelXp: levels[level] ?? levels[levels.length - 1] }
}

// ─── getXp ────────────────────────────────────────────────────────────────────

export async function getXp(username: string) {
  const user = await prisma.user.findUnique({ where: { username }, select: { reputation: true } });
  if (!user) throw notFound("User not found");
  return calculateXp(user.reputation);
}

// ─── getUserStats ─────────────────────────────────────────────────────────────

export async function getUserStats(username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    include: {
      _count: {
        select: {
          listEntries: true,
          posts: true,
          reviews: true,
          blogs: true,
          followers: true,
          following: true,
        },
      },
    },
  });
  if (!user) throw notFound(`User ${username} not found`);
  const xpData = calculateXp(user.reputation);
  return {
    username: user.username,
    displayName: user.displayName,
    reputation: user.reputation,
    ...xpData,
    stats: user._count,
  };
}

// ─── unfollow ─────────────────────────────────────────────────────────────────

export async function unfollow(followerId: string, targetUsername: string) {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw notFound("User not found");

  await prisma.follow.deleteMany({
    where: { followerId, followingId: target.id },
  });
}

// ─── getFollowers ─────────────────────────────────────────────────────────────

export async function getFollowers(username: string, page = 1, limit = 20) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw notFound("User not found");

  const skip = (page - 1) * limit;
  const [rows, total] = await prisma.$transaction([
    prisma.follow.findMany({
      where: { followingId: user.id },
      skip,
      take: limit,
      include: { follower: { select: safeUserSelect } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.follow.count({ where: { followingId: user.id } }),
  ]);

  return {
    data: rows.map((r: { follower: unknown }) => r.follower),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

// ─── exportMyData ─────────────────────────────────────────────────────────────

export async function exportMyData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      listEntries: { include: { anime: true } },
      posts: { take: 100, orderBy: { createdAt: "desc" } },
      reviews: { take: 50 },
      blogs: { take: 50 },
      notifications: { take: 100, orderBy: { createdAt: "desc" } },
    },
  });
  if (!user) throw notFound("User not found");
  const { passwordHash: _, ...safeUser } = user;
  return safeUser;
}

// ─── getFollowing ─────────────────────────────────────────────────────────────

export async function getFollowing(username: string, page = 1, limit = 20) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw notFound("User not found");

  const skip = (page - 1) * limit;
  const [rows, total] = await prisma.$transaction([
    prisma.follow.findMany({
      where: { followerId: user.id },
      skip,
      take: limit,
      include: { following: { select: safeUserSelect } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.follow.count({ where: { followerId: user.id } }),
  ]);

  return {
    data: rows.map((r: { following: unknown }) => r.following),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}
