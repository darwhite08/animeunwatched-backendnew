import { prisma } from "../../config/prisma";
import { Prisma } from "../../generated/prisma/client";
import { grantFoundingCreatorBadge } from "../../lib/founding";
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

  // Becoming a Verified Creator is the trigger for the Founding Creator badge
  // (first 250, first-come). Fire after the verification commit; never let it
  // block or fail the verification flow.
  if (kind === "CREATOR") {
    void grantFoundingCreatorBadge(user.id).catch((e) =>
      console.error("[founding] grant after setVerification failed:", e),
    );
  }

  return { user: updated };
}

/**
 * Grant the Verified Creator badge to a user (idempotent), then fire the
 * Founding Creator grant. The programmatic entry point for the verified-creator
 * flow; the admin path (setVerification) triggers founding too. Returns the
 * Founding badge if one was issued, else null (window closed / already founding).
 */
export async function grantVerifiedCreatorBadge(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { verifiedKind: "CREATOR", verifiedAt: new Date() },
    select: { id: true },
  });
  return grantFoundingCreatorBadge(userId);
}

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(username: string, viewerId?: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      ...safeUserSelect,
      streakDays: true,
      bestStreak: true,
      lastActiveAt: true,
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
          authorId: true,
          content: true,
          animeId: true,
          imageUrl: true,
          createdAt: true,
          anime: { select: { title: true, malId: true } },
          _count: { select: { likes: true, comments: true } },
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
      badges: {
        orderBy: { earnedAt: "desc" },
        select: { code: true, serial: true, earnedAt: true },
      },
    },
  });

  if (!user) throw notFound("User not found");

  const { _count, posts, reviews, badges, ...rest } = user;

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

  // 1-based global rank by reputation among non-banned users.
  const rank =
    (await prisma.user.count({
      where: { isBanned: false, reputation: { gt: rest.reputation } },
    })) + 1;

  // Email is account-private — only the owner sees it on their own profile.
  const { email: _email, ...publicUser } = rest;

  return {
    user: { ...(viewerId === rest.id ? rest : publicUser), isFollowing, followRequested },
    isFollowing,
    followRequested,
    isPrivate: rest.isPrivate,
    locked,
    stats: {
      followers: _count.followers,
      following: _count.following,
      listCount: _count.listEntries,
      reviewCount: _count.reviews,
      rank,
    },
    recentPosts: locked ? [] : posts,
    recentReviews: locked ? [] : reviews,
    badges: locked ? [] : badges,
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

  // Endowed-progress head start (Nunes & Drèze 2006: 2 pre-filled stamps lifted
  // completion 19%→34%): pre-add two strong picks from the user's chosen genres
  // so the starter archive begins partly complete. The effect requires a STATED
  // REASON — the client surfaces "because you chose <genres>" with these picks.
  let endowed: Array<{ malId: number | null; title: string; imageUrl: string | null }> = [];
  if (clean.length) {
    try {
      const existing = await prisma.listEntry.findMany({ where: { userId }, select: { animeId: true } });
      const picks = await prisma.anime.findMany({
        where: {
          id: { notIn: existing.map((e: { animeId: string }) => e.animeId) },
          score: { not: null },
          genres: { some: { genre: { name: { in: clean } } } },
        },
        orderBy: { score: "desc" },
        take: 2,
        select: { id: true, malId: true, title: true, imageUrl: true },
      });
      if (picks.length) {
        await prisma.listEntry.createMany({
          data: picks.map((p: { id: string }) => ({ userId, animeId: p.id, status: "PLAN_TO_WATCH" as const })),
          skipDuplicates: true,
        });
        endowed = picks.map((p: { malId: number | null; title: string; imageUrl: string | null }) =>
          ({ malId: p.malId, title: p.title, imageUrl: p.imageUrl }));
      }
    } catch { /* endowment is best-effort — onboarding still succeeds without it */ }
  }

  return { user, endowed };
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

// ─── Board leaderboards ───────────────────────────────────────────────────────
// Five boards, each backed by a real aggregate:
//   episodes — SUM(ListEntry.episodesSeen)        (windowable via updatedAt)
//   reviews  — COUNT(Review) + likes received     (windowable via createdAt)
//   streak   — User.streakDays / bestStreak       (window-agnostic)
//   followed — COUNT(Follow ACCEPTED)             (window-agnostic)
//   xp       — reputation * 100                   (window-agnostic, no history)

export const BOARD_IDS = ["episodes", "reviews", "streak", "followed", "xp"] as const;
export type BoardId = (typeof BOARD_IDS)[number];
const BOARD_WINDOWED: Record<BoardId, boolean> = {
  episodes: true, reviews: true, streak: false, followed: false, xp: false,
};

const lbLevel = (rep: number) =>
  Math.max(1, Math.min(99, Math.floor(Math.sqrt(Math.max(0, rep) * 100 / 1000))));

/** (userId, value, sec) per board — sec is the tie-breaker / secondary stat. */
function boardCte(board: BoardId, since: Date | null): Prisma.Sql {
  switch (board) {
    case "episodes":
      return Prisma.sql`
        SELECT le."userId" AS uid, SUM(le."episodesSeen")::int AS value, COUNT(*)::int AS sec
        FROM "ListEntry" le
        ${since ? Prisma.sql`WHERE le."updatedAt" >= ${since}` : Prisma.empty}
        GROUP BY 1
        HAVING SUM(le."episodesSeen") > 0`;
    case "reviews":
      return Prisma.sql`
        SELECT r."authorId" AS uid, COUNT(*)::int AS value, COALESCE(SUM(lk.n), 0)::int AS sec
        FROM "Review" r
        LEFT JOIN (SELECT "reviewId", COUNT(*) AS n FROM "ReviewLike" GROUP BY 1) lk
          ON lk."reviewId" = r.id
        ${since ? Prisma.sql`WHERE r."createdAt" >= ${since}` : Prisma.empty}
        GROUP BY 1`;
    case "streak":
      return Prisma.sql`
        SELECT u.id AS uid, u."streakDays"::int AS value, u."bestStreak"::int AS sec
        FROM "User" u
        WHERE u."streakDays" > 0`;
    case "followed":
      return Prisma.sql`
        SELECT f."followingId" AS uid, COUNT(*)::int AS value, 0 AS sec
        FROM "Follow" f
        WHERE f.status = 'ACCEPTED'
        GROUP BY 1`;
    case "xp":
      return Prisma.sql`
        SELECT u.id AS uid, (u.reputation * 100)::int AS value, COALESCE(le.n, 0)::int AS sec
        FROM "User" u
        LEFT JOIN (SELECT "userId", COUNT(*) AS n FROM "ListEntry" GROUP BY 1) le
          ON le."userId" = u.id
        WHERE u.reputation > 0`;
  }
}

/** Full ranked global standings for one board (all-time) — used by the daily
 *  snapshot job. Capped to keep snapshot size bounded. */
export async function computeGlobalStandings(board: BoardId, limit = 1000) {
  const cte = boardCte(board, null);
  return prisma.$queryRaw<Array<{ uid: string; value: number; sec: number }>>`
    SELECT m.uid, m.value, m.sec
    FROM (${cte}) m
    JOIN "User" u ON u.id = m.uid
    WHERE u."isBanned" = false
    ORDER BY m.value DESC, m.sec DESC, m.uid ASC
    LIMIT ${limit}`;
}

export async function getBoardLeaderboard(opts: {
  board: BoardId;
  window: "week" | "month" | "all";
  audience: "global" | "friends";
  limit: number;
  viewerId?: string;
}) {
  const { board, audience, limit, viewerId } = opts;
  // Window-agnostic boards always report "all" so the client can grey the toggle.
  const window = BOARD_WINDOWED[board] ? opts.window : "all";
  const since =
    window === "week"  ? new Date(Date.now() -  7 * 86_400_000) :
    window === "month" ? new Date(Date.now() - 30 * 86_400_000) : null;

  // Friends scope = people the viewer follows (ACCEPTED) + the viewer.
  let scopeIds: string[] | null = null;
  if (audience === "friends") {
    if (!viewerId) return { board, window, audience, total: 0, data: [], me: null };
    const follows = await prisma.follow.findMany({
      where: { followerId: viewerId, status: "ACCEPTED" },
      select: { followingId: true },
    });
    scopeIds = [...follows.map((f: { followingId: string }) => f.followingId), viewerId];
  }

  const cte = boardCte(board, since);
  const scopeSql = scopeIds
    ? Prisma.sql`AND m.uid IN (${Prisma.join(scopeIds)})`
    : Prisma.empty;

  const cacheKey = `lb:${board}:${window}:${audience}:${audience === "friends" ? viewerId : ""}`;
  type Agg = { uid: string; value: number; sec: number };
  let computed = cache.get(cacheKey) as { top: Agg[]; total: number } | undefined;
  if (!computed) {
    const top = await prisma.$queryRaw<Agg[]>`
      SELECT m.uid, m.value, m.sec
      FROM (${cte}) m
      JOIN "User" u ON u.id = m.uid
      WHERE u."isBanned" = false ${scopeSql}
      ORDER BY m.value DESC, m.sec DESC, m.uid ASC
      LIMIT ${limit}`;
    const totalRows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
      FROM (${cte}) m
      JOIN "User" u ON u.id = m.uid
      WHERE u."isBanned" = false ${scopeSql}`;
    computed = { top, total: totalRows[0]?.n ?? 0 };
    // Global boards are identical for everyone — cache briefly. Friends boards
    // are per-viewer; skip the cache to avoid unbounded keys.
    if (audience === "global") cache.set(cacheKey, computed, 60_000);
  }
  const { top, total } = computed;

  // Hydrate public user objects + the viewer's follow state for the rows.
  const uids = top.map((r) => r.uid);
  const users = uids.length
    ? await prisma.user.findMany({
        where: { id: { in: uids } },
        select: {
          id: true, username: true, slug: true, displayName: true, avatarUrl: true,
          verifiedKind: true, reputation: true, streakDays: true, bestStreak: true,
        },
      })
    : [];
  const byId = new Map(users.map((u: (typeof users)[0]) => [u.id, u]));

  let followingSet = new Set<string>();
  if (viewerId && uids.length) {
    const fs = await prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: uids }, status: "ACCEPTED" },
      select: { followingId: true },
    });
    followingSet = new Set(fs.map((f: { followingId: string }) => f.followingId));
  }

  // Rank-movement deltas vs the most recent prior daily snapshot. Snapshots
  // cover all-time global standings only, so deltas are served only there —
  // windowed/friends views get null (the client hides the chip).
  const prevRankById = new Map<string, number>();
  let hasSnapshot = false;
  if (audience === "global" && window === "all" && uids.length) {
    const todayKey = new Date().toISOString().slice(0, 10);
    const prevDay = await prisma.leaderboardSnapshot.findFirst({
      where: { board, date: { lt: todayKey } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (prevDay) {
      hasSnapshot = true;
      const prev = await prisma.leaderboardSnapshot.findMany({
        where: { board, date: prevDay.date, userId: { in: uids } },
        select: { userId: true, rank: true },
      });
      prev.forEach((p: { userId: string; rank: number }) => prevRankById.set(p.userId, p.rank));
    }
  }

  const data = top.flatMap((r, i) => {
    const u = byId.get(r.uid);
    if (!u) return [];
    const prevRank = prevRankById.get(r.uid);
    return [{
      rank: i + 1,
      value: r.value,
      secondary: board === "followed" ? lbLevel(u.reputation) : r.sec,
      isFollowing: followingSet.has(r.uid),
      delta: hasSnapshot && prevRank !== undefined ? prevRank - (i + 1) : null,
      isNew: hasSnapshot && prevRank === undefined,
      user: {
        id: u.id, username: u.username, slug: u.slug, displayName: u.displayName,
        avatarUrl: u.avatarUrl, verifiedKind: u.verifiedKind,
        reputation: u.reputation, level: lbLevel(u.reputation),
      },
    }];
  });

  // Viewer standing on this board (rank within the same scope) + the value of
  // the user one rank ahead, so the client can render "X to pass #N".
  let me: { rank: number; value: number; secondary: number; nextValue: number | null } | null = null;
  if (viewerId) {
    const mine = await prisma.$queryRaw<Agg[]>`
      SELECT m.uid, m.value, m.sec FROM (${cte}) m WHERE m.uid = ${viewerId} LIMIT 1`;
    if (mine.length) {
      const { value, sec } = mine[0];
      const ahead = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n
        FROM (${cte}) m
        JOIN "User" u ON u.id = m.uid
        WHERE u."isBanned" = false ${scopeSql}
          AND (m.value > ${value} OR (m.value = ${value} AND m.sec > ${sec}))`;
      const rank = (ahead[0]?.n ?? 0) + 1;
      let nextValue: number | null = null;
      if (rank > 1) {
        const inTop = top[rank - 2];
        if (inTop) {
          nextValue = inTop.value;
        } else {
          const next = await prisma.$queryRaw<Array<{ value: number }>>`
            SELECT m.value
            FROM (${cte}) m
            JOIN "User" u ON u.id = m.uid
            WHERE u."isBanned" = false ${scopeSql}
            ORDER BY m.value DESC, m.sec DESC, m.uid ASC
            OFFSET ${rank - 2} LIMIT 1`;
          nextValue = next[0]?.value ?? null;
        }
      }
      me = { rank, value, secondary: sec, nextValue };
    }
  }

  return { board, window, audience, total, data, me };
}
