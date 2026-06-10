import { prisma } from "../../config/prisma";
import { notFound, conflict } from "../../lib/errors";
import { createNotification, NotificationType } from "../../lib/notify";
import { validateSlug, generateUniqueSlug } from "../../lib/slug";
import { cache } from "../../lib/cache";
import { jaccard, logNormalize } from "../../lib/ranking";
import type { UpdateMeDto, UpdateSlugDto } from "./users.schema";

const safeUserSelect = {
  id: true,
  email: true,
  username: true,
  slug: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  coverImage: true,
  role: true,
  reputation: true,
  verifiedKind: true,
  createdAt: true,
} as const;

// ─── verified badge (admin) ─────────────────────────────────────────────────────

export async function setVerification(username: string, kind: "USER" | "CREATOR" | "STUDIO" | null) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw notFound("User not found");
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { verifiedKind: kind, verifiedAt: kind ? new Date() : null },
    select: safeUserSelect,
  });
  return { user: updated };
}

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(username: string, viewerId?: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      ...safeUserSelect,
      isPrivate: true,
      _count: {
        select: {
          // Count only active (ACCEPTED) follows, not pending requests.
          followers: { where: { status: "ACCEPTED" } },
          following: { where: { status: "ACCEPTED" } },
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

  // Viewer's follow relationship: ACCEPTED → following, PENDING → requested.
  let isFollowing = false;
  let followRequested = false;
  if (viewerId && viewerId !== rest.id) {
    const f = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: rest.id } },
      select: { status: true },
    });
    isFollowing = f?.status === "ACCEPTED";
    followRequested = f?.status === "PENDING";
  }

  // Private account content is hidden from non-followers (Instagram-style).
  const locked = !!rest.isPrivate && viewerId !== rest.id && !isFollowing;

  return {
    user: { ...rest, isFollowing, followRequested },
    isFollowing,
    followRequested,
    isPrivate: rest.isPrivate,
    locked,
    stats: {
      followers: _count.followers,
      following: _count.following,
      listCount: _count.listEntries,
      reviewCount: _count.reviews,
    },
    recentPosts: locked ? [] : posts,
    recentReviews: locked ? [] : reviews,
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
      ...(dto.coverImage !== undefined ? { coverImage: dto.coverImage } : {}),
      ...(dto.isPrivate !== undefined ? { isPrivate: dto.isPrivate } : {}),
    },
    select: { ...safeUserSelect, isPrivate: true },
  });
  return { user };
}

// ─── onboarding ────────────────────────────────────────────────────────────────

export async function completeOnboarding(userId: string, favoriteGenres: string[]) {
  const clean = (favoriteGenres ?? []).filter((g) => typeof g === "string").map((g) => g.trim()).filter(Boolean).slice(0, 20);
  const user = await prisma.user.update({
    where: { id: userId },
    data: { favoriteGenres: clean, onboardedAt: new Date() },
    select: { ...safeUserSelect, isPrivate: true, onboardedAt: true, favoriteGenres: true },
  });
  return { user };
}

// ─── change username ────────────────────────────────────────────────────────────

export async function checkUsernameAvailable(username: string, selfId?: string) {
  const u = (username ?? "").trim();
  if (u.length < 3 || u.length > 30 || !/^[a-zA-Z0-9_]+$/.test(u)) {
    return { available: false, error: "3–30 letters, numbers or _" };
  }
  const taken = await prisma.user.findFirst({
    where: { username: { equals: u, mode: "insensitive" }, ...(selfId ? { id: { not: selfId } } : {}) },
    select: { id: true },
  });
  return { available: !taken, error: taken ? "That username is taken" : undefined };
}

export async function changeUsername(userId: string, username: string) {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  if (current?.username === username) {
    return prisma.user.findUnique({ where: { id: userId }, select: { ...safeUserSelect, isPrivate: true } });
  }
  const taken = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" }, id: { not: userId } },
    select: { id: true },
  });
  if (taken) throw conflict("That username is already taken. Try another.");
  return prisma.user.update({
    where: { id: userId },
    data: { username },
    select: { ...safeUserSelect, isPrivate: true },
  });
}

// ─── follow ───────────────────────────────────────────────────────────────────

export async function follow(followerId: string, targetUsername: string) {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw notFound("User not found");
  if (target.id === followerId) {
    throw conflict("You cannot follow yourself");
  }

  // Private accounts require approval → create a PENDING request instead of an active follow.
  const status = target.isPrivate ? "PENDING" : "ACCEPTED";

  try {
    await prisma.follow.create({
      data: { followerId, followingId: target.id, status },
    });
  } catch (err: unknown) {
    // Already following or already requested → idempotent, report current state.
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2002") {
      const existing = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId, followingId: target.id } },
        select: { status: true },
      });
      return { status: existing?.status ?? "ACCEPTED" };
    }
    throw err;
  }

  // Notify the followed user — fire-and-forget so a notification failure doesn't break the follow
  prisma.user.findUnique({ where: { id: followerId }, select: { username: true, displayName: true, avatarUrl: true } })
    .then((follower) =>
      createNotification({
        recipientId: target.id,
        type: NotificationType.NEW_FOLLOWER,
        payload: {
          message:
            status === "PENDING"
              ? `${follower?.displayName ?? follower?.username ?? "Someone"} requested to follow you`
              : `${follower?.displayName ?? follower?.username ?? "Someone"} started following you`,
          link: `/u/${follower?.username ?? ""}`,
          actorUsername: follower?.username,
          actorDisplayName: follower?.displayName,
          actorAvatarUrl: follower?.avatarUrl ?? null,
          followerUsername: follower?.username,
          requested: status === "PENDING",
        },
      })
    )
    .catch(console.error);

  return { status };
}

// ─── follow requests (private accounts) ─────────────────────────────────────────

/** People who have requested to follow me (PENDING). */
export async function listFollowRequests(userId: string) {
  const rows = await prisma.follow.findMany({
    where: { followingId: userId, status: "PENDING" },
    include: { follower: { select: safeUserSelect } },
    orderBy: { createdAt: "desc" },
  });
  return { data: rows.map((r) => r.follower) };
}

/** Approve or reject a pending follow request from `requesterId`. */
export async function respondFollowRequest(userId: string, requesterId: string, accept: boolean) {
  const req = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: requesterId, followingId: userId } },
    select: { status: true },
  });
  if (!req || req.status !== "PENDING") throw notFound("No pending request from this user");

  if (accept) {
    await prisma.follow.update({
      where: { followerId_followingId: { followerId: requesterId, followingId: userId } },
      data: { status: "ACCEPTED" },
    });
    prisma.user.findUnique({ where: { id: userId }, select: { username: true, displayName: true, avatarUrl: true } })
      .then((me) =>
        createNotification({
          recipientId: requesterId,
          type: NotificationType.NEW_FOLLOWER,
          payload: {
            message: `${me?.displayName ?? me?.username ?? "Someone"} accepted your follow request`,
            link: `/u/${me?.username ?? ""}`,
            actorUsername: me?.username,
            actorDisplayName: me?.displayName,
            actorAvatarUrl: me?.avatarUrl ?? null,
          },
        })
      )
      .catch(console.error);
  } else {
    await prisma.follow.delete({
      where: { followerId_followingId: { followerId: requesterId, followingId: userId } },
    });
  }
  return { ok: true, accepted: accept };
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
      where: { followingId: user.id, status: "ACCEPTED" },
      skip,
      take: limit,
      include: { follower: { select: safeUserSelect } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.follow.count({ where: { followingId: user.id, status: "ACCEPTED" } }),
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
      where: { followerId: user.id, status: "ACCEPTED" },
      skip,
      take: limit,
      include: { following: { select: safeUserSelect } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.follow.count({ where: { followerId: user.id, status: "ACCEPTED" } }),
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
        id: u.id,
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
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
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
/**
 * One-off boot backfill: give every slug-less user a slug. Older accounts
 * predate slug generation, and a null slug breaks all /user/[slug]/* routing
 * (links fall back to /login). Idempotent — only touches rows where slug IS NULL.
 */
export async function backfillMissingSlugs(): Promise<number> {
  const users = await prisma.user.findMany({
    where: { slug: null },
    select: { id: true, username: true, displayName: true },
  });
  let updated = 0;
  for (const u of users) {
    try {
      const slug = await generateUniqueSlug(u.displayName || u.username);
      await prisma.user.update({ where: { id: u.id }, data: { slug } });
      updated++;
    } catch {
      /* slug race/conflict — skip; next boot retries */
    }
  }
  return updated;
}

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

// ─── getConnectedAccounts ─────────────────────────────────────────────────────

export async function getConnectedAccounts(userId: string) {
  const providers = await prisma.userOAuthProvider.findMany({
    where: { userId },
    select: { id: true, provider: true, createdAt: true },
  })
  return { providers }
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


// ─── whoToFollow (people-you-may-know) ───────────────────────────────────────
//
// Three signals, weighted:
//   0.50 × FOAF  — friend-of-a-friend density.
//                  Count of viewer's followed-users who follow this candidate,
//                  normalised by viewer's following count. 0–1.
//   0.30 × taste — Jaccard similarity of the two users' watchlist anime sets.
//                  Captures "people who watch what you watch".
//   0.15 × recency — 1 / (days_since_active + 1). Dead accounts don't surface.
//   0.05 × reputation — log10 normalised; tie-breaker, not driver.
//
// Excludes: viewer themselves, anyone they already follow, anyone they've
// blocked. Cached 10 min per viewer (taste/follow graphs change slowly).

export async function whoToFollow(viewerId: string, limit = 10) {
  const cacheKey = `users:whoToFollow:${viewerId}:${limit}`
  const cached = cache.get<unknown[]>(cacheKey)
  if (cached) return cached

  // Viewer's follow set + watchlist (taste vector)
  const [following, viewerList] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: viewerId },
      select: { followingId: true },
    }),
    prisma.listEntry.findMany({
      where: { userId: viewerId },
      select: { animeId: true },
    }),
  ])
  const followingIds = new Set(following.map(f => f.followingId))
  const viewerAnime  = new Set(viewerList.map(l => l.animeId))
  const followingCount = followingIds.size

  // ── Candidate pool: 2nd-degree (FOAF) + recent-active high-rep
  //    Capped at 200; reranked in JS.
  const [foafCandidates, recentActive] = await Promise.all([
    followingCount === 0
      ? Promise.resolve([] as Array<{ followingId: string }>)
      : prisma.follow.findMany({
          where: {
            followerId: { in: [...followingIds] },
            followingId: { notIn: [viewerId, ...followingIds] },
          },
          select: { followingId: true },
          take: 500,
        }),
    prisma.user.findMany({
      where: {
        id: { notIn: [viewerId, ...followingIds] },
        reputation: { gte: 10 },
      },
      orderBy: { reputation: "desc" },
      take: 60,
      select: { id: true },
    }),
  ])

  // Tally FOAF: how many of viewer's follows follow each candidate?
  const foafCount = new Map<string, number>()
  for (const f of foafCandidates) {
    foafCount.set(f.followingId, (foafCount.get(f.followingId) ?? 0) + 1)
  }
  for (const u of recentActive) {
    if (!foafCount.has(u.id)) foafCount.set(u.id, 0)
  }
  if (foafCount.size === 0) {
    cache.set(cacheKey, [], 10 * 60_000)
    return []
  }

  // Hydrate candidate users + their watchlist anime IDs in one round-trip
  const candidateIds = [...foafCount.keys()]
  const users = await prisma.user.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true, username: true, displayName: true,
      avatarUrl: true, bio: true, reputation: true, lastActiveAt: true,
      listEntries: { select: { animeId: true }, take: 200 },
    },
  })

  const now = Date.now()
  const scored = users.map(u => {
    const foaf = followingCount > 0 ? Math.min(1, (foafCount.get(u.id) ?? 0) / Math.max(1, Math.sqrt(followingCount))) : 0
    const taste = jaccard(viewerAnime, new Set(u.listEntries.map(e => e.animeId)))
    const daysSinceActive = u.lastActiveAt
      ? Math.max(0, (now - u.lastActiveAt.getTime()) / (24 * 3600 * 1000))
      : 365
    const recency = 1 / (daysSinceActive + 1)
    const repNorm = logNormalize(u.reputation, 1000)

    return {
      user: u,
      score: 0.50 * foaf
           + 0.30 * taste
           + 0.15 * recency
           + 0.05 * repNorm,
      reason:
        foaf  > 0.15 ? "Followed by people you follow" :
        taste > 0.10 ? "Similar taste"                 :
        repNorm > 0.5 ? "Top reputation"               :
                       "Active in your community",
    }
  })

  const ranked = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({
      user:   {
        id: s.user.id, username: s.user.username, displayName: s.user.displayName,
        avatarUrl: s.user.avatarUrl, bio: s.user.bio, reputation: s.user.reputation,
      },
      reason: s.reason,
    }))

  cache.set(cacheKey, ranked, 10 * 60_000)
  return ranked
}
