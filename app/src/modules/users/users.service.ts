import { prisma } from "../../config/prisma";
import { notFound, conflict } from "../../lib/errors";
import { createNotification, NotificationType } from "../../lib/notify";
import { validateSlug } from "../../lib/slug";
import type { UpdateMeDto, UpdateSlugDto } from "./users.schema";

const safeUserSelect = {
  id: true,
  email: true,
  username: true,
  slug: true,
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

  // Notify the followed user — fire-and-forget so a notification failure doesn't break the follow
  prisma.user.findUnique({ where: { id: followerId }, select: { username: true, displayName: true } })
    .then((follower) =>
      createNotification({
        recipientId: target.id,
        type: NotificationType.NEW_FOLLOWER,
        payload: {
          message: `${follower?.displayName ?? follower?.username ?? "Someone"} started following you`,
          link: `/u/${follower?.username ?? ""}`,
          followerUsername: follower?.username,
        },
      })
    )
    .catch(console.error);
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
    select: {
      // Safe fields only — never export passwordHash, isBanned, refreshTokens, oauthProviders
      id: true, email: true, username: true, displayName: true,
      bio: true, avatarUrl: true, role: true, reputation: true, createdAt: true, updatedAt: true,
      listEntries: { include: { anime: { select: { malId: true, title: true } } }, take: 500 },
      posts:        { take: 100, orderBy: { createdAt: "desc" }, select: { id: true, content: true, createdAt: true } },
      reviews:      { take: 100, orderBy: { createdAt: "desc" }, select: { id: true, score: true, body: true, createdAt: true } },
      blogs:        { take: 50,  orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true, publishedAt: true } },
      notifications:{ take: 100, orderBy: { createdAt: "desc" }, select: { id: true, type: true, payload: true, read: true, createdAt: true } },
    },
  });
  if (!user) throw notFound("User not found");
  return user;
}

// ─── getActivity ─────────────────────────────────────────────────────────────

export async function getActivity(username: string, limit = 20) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw notFound("User not found");
  const perSection = Math.floor(limit / 3);
  const [posts, reviews, listEntries] = await prisma.$transaction([
    prisma.post.findMany({
      where: { authorId: user.id, deletedAt: null },
      take: perSection,
      orderBy: { createdAt: "desc" },
      include: { anime: { select: { title: true, malId: true } } },
    }),
    prisma.review.findMany({
      where: { authorId: user.id },
      take: perSection,
      orderBy: { createdAt: "desc" },
      include: { anime: { select: { title: true, malId: true } } },
    }),
    prisma.listEntry.findMany({
      where: { userId: user.id },
      take: perSection,
      orderBy: { updatedAt: "desc" },
      include: { anime: { select: { title: true, malId: true } } },
    }),
  ]);
  return { posts, reviews, listEntries };
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

// ─── getLeaderboard ───────────────────────────────────────────────────────────

export async function getLeaderboard(limit = 50, period = "all-time") {
  const users = await prisma.user.findMany({
    where: { isBanned: false },
    orderBy: { reputation: "desc" },
    take: limit,
    select: {
      ...safeUserSelect,
      _count: { select: { listEntries: true, reviews: true, posts: true } },
    },
  });

  return {
    data: users.map((u: typeof users[0], i: number) => {
      const xp = u.reputation * 100;
      const level = Math.min(99, Math.floor(Math.sqrt(xp / 1000)));
      return {
        rank: i + 1,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        reputation: u.reputation,
        xp,
        level: Math.max(1, level),
        archived: u._count.listEntries,
        reviews: u._count.reviews,
        posts: u._count.posts,
      };
    }),
    meta: { total: users.length, period },
  };
}

// ─── Friends activity feed ────────────────────────────────────────────────────

/** Get recent list activity from people the user follows */
export async function getFollowingActivity(username: string, limit = 10) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw notFound("User not found");

  const following = await prisma.follow.findMany({
    where: { followerId: user.id },
    select: { followingId: true },
    take: 50,
  });

  if (following.length === 0) return { data: [] };

  const entries = await prisma.listEntry.findMany({
    where: {
      userId: { in: following.map((f: { followingId: string }) => f.followingId) },
      animeId: { not: "" },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      user: { select: { username: true, displayName: true, avatarUrl: true } },
      anime: { select: { malId: true, title: true, imageUrl: true } },
    },
  });

  return {
    data: entries
      .filter(e => e.anime)
      .map(e => ({
        user:      e.user,
        anime:     e.anime,
        status:    e.status,
        updatedAt: e.updatedAt.toISOString(),
      })),
  };
}

// ─── Slug management ──────────────────────────────────────────────────────────

/** Check if a slug is available (and valid format). Returns immediately — used for live validation. */
export async function checkSlugAvailable(slug: string): Promise<{ available: boolean; error?: string }> {
  const formatError = validateSlug(slug);
  if (formatError) return { available: false, error: formatError };

  const existing = await prisma.user.findUnique({ where: { slug }, select: { id: true } });
  return { available: !existing };
}

// ─── getUserPosts ─────────────────────────────────────────────────────────────

export async function getUserPosts(username: string, page = 1, limit = 20) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
  if (!user) throw notFound("User not found")
  const skip = (page - 1) * limit
  const [data, total] = await prisma.$transaction([
    prisma.post.findMany({
      where: { authorId: user.id, deletedAt: null },
      include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } }, anime: { select: { id: true, malId: true, title: true, imageUrl: true } }, _count: { select: { likes: true, comments: true } } },
      orderBy: { createdAt: "desc" },
      skip, take: limit,
    }),
    prisma.post.count({ where: { authorId: user.id, deletedAt: null } }),
  ])
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } }
}

/** Update the authenticated user's slug. Validates format + uniqueness (excluding self). */
export async function updateSlug(userId: string, dto: UpdateSlugDto) {
  const formatError = validateSlug(dto.slug);
  if (formatError) throw conflict(formatError);

  const taken = await prisma.user.findFirst({
    where: { slug: dto.slug, id: { not: userId } },
    select: { id: true },
  });
  if (taken) throw conflict("This slug is already taken. Try a different one.");

  return prisma.user.update({
    where:  { id: userId },
    data:   { slug: dto.slug },
    select: safeUserSelect,
  });
}
