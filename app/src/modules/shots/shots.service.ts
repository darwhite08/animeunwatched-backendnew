import { prisma } from "../../config/prisma";
import { notFound, forbidden, badRequest } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { createNotification, NotificationType } from "../../lib/notify";
import type { CreateShotDto } from "./shots.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const shotInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      verifiedKind: true,
    },
  },
  anime: {
    select: {
      id: true,
      malId: true,
      title: true,
      imageUrl: true,
    },
  },
  _count: {
    select: { likes: true, comments: { where: { deletedAt: null } }, saves: true },
  },
} as const;

/** Attach per-viewer flags (liked / saved / author-followed) when userId is known. */
async function decorate<T extends { id: string; authorId: string }>(shots: T[], userId?: string) {
  if (!userId || shots.length === 0) {
    return shots.map(s => ({ ...s, isLikedByMe: false, isSavedByMe: false, authorFollowedByMe: false }));
  }
  const ids = shots.map(s => s.id);
  const authorIds = [...new Set(shots.map(s => s.authorId))];
  const [likes, saves, follows] = await Promise.all([
    prisma.shotLike.findMany({ where: { userId, shotId: { in: ids } }, select: { shotId: true } }),
    prisma.shotSave.findMany({ where: { userId, shotId: { in: ids } }, select: { shotId: true } }),
    prisma.follow.findMany({ where: { followerId: userId, followingId: { in: authorIds }, status: "ACCEPTED" }, select: { followingId: true } }),
  ]);
  const liked = new Set(likes.map(l => l.shotId));
  const saved = new Set(saves.map(s => s.shotId));
  const followed = new Set(follows.map(f => f.followingId));
  return shots.map(s => ({ ...s, isLikedByMe: liked.has(s.id), isSavedByMe: saved.has(s.id), authorFollowedByMe: followed.has(s.authorId) }));
}

// ─── getFeed ──────────────────────────────────────────────────────────────────
// "following" → chronological feed of followed authors (cursor = createdAt).
// default    → personalized Instagram-style ranked feed (cursor = opaque seen
//              token). See docs/shots-recommendation-algorithm.md.

export async function getFeed(userId?: string, cursor?: string, limit = 10, filter?: "following") {
  if (filter === "following") {
    if (!userId) return { data: [], meta: { nextCursor: null } };
    const follows = await prisma.follow.findMany({ where: { followerId: userId, status: "ACCEPTED" }, select: { followingId: true } });
    const ids = follows.map(f => f.followingId);
    if (ids.length === 0) return { data: [], meta: { nextCursor: null } };
    const shots = await prisma.shot.findMany({
      where: { deletedAt: null, authorId: { in: ids }, ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}) },
      take: limit + 1,
      orderBy: { createdAt: "desc" },
      include: shotInclude,
    });
    const hasMore = shots.length > limit;
    const slice = hasMore ? shots.slice(0, limit) : shots;
    const data = await decorate(slice, userId);
    const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;
    return { data, meta: { nextCursor } };
  }
  return getRankedFeed(userId, cursor, limit);
}

// ─── Shots Rank — personalized recommendation feed ────────────────────────────
// Faithful, Postgres-only adaptation of how Instagram ranks Reels: a multi-signal
// value score (engagement-per-view × watch-through) × freshness decay × personal
// affinity × integrity, then diversity + exploration reranking. Full research &
// rationale in docs/shots-recommendation-algorithm.md.

const RANK = {
  poolDays: 45,            // only ever recommend recent shots (freshness, like Reels)
  poolSize: 300,           // candidates scored per request
  gravity: 1.2,            // freshness decay exponent
  priorC: 8,               // Bayesian shrink strength (in "views")
  priorMean: 0.15,         // prior weighted-engagement per view
  wLike: 1, wComment: 3, wSave: 5,   // action weights (saves > comments > likes)
  testMaxAgeH: 48, testMaxViews: 50, testBoost: 1.35,  // cold-start test audience
  affFollow: 1.6, affEngAuthor: 1.3, affTopic: 1.3, ownShot: 0.3,
  demoteRepost: 0.7, demoteNoThumb: 0.9,               // integrity/quality
  perAuthorCap: 2,         // diversity: max shots per author per page
  exploreFraction: 0.2,    // ε-greedy exploration share of each page
  seenCap: 400,            // bound the opaque cursor size
} as const;

function decodeSeen(cursor?: string): string[] {
  if (!cursor) return [];
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    return Array.isArray(o?.seen) ? (o.seen as string[]) : [];
  } catch { return []; }
}
function encodeSeen(seen: string[]): string {
  return Buffer.from(JSON.stringify({ seen: seen.slice(-RANK.seenCap) })).toString("base64");
}

export async function getRankedFeed(userId: string | undefined, cursor: string | undefined, limit = 10) {
  const seen = decodeSeen(cursor);
  const since = new Date(Date.now() - RANK.poolDays * 86_400_000);

  // Stage 1 — candidate pool: recent, not-deleted, not-already-served.
  const pool = await prisma.shot.findMany({
    where: { deletedAt: null, createdAt: { gte: since }, ...(seen.length ? { id: { notIn: seen } } : {}) },
    take: RANK.poolSize,
    orderBy: { createdAt: "desc" },
    include: shotInclude,
  });
  if (pool.length === 0) return { data: [], meta: { nextCursor: null } };
  const ids = pool.map(s => s.id);

  // Watch-through stats (strongest Reels signal) + personalization sets.
  const [watch, follows, engRows] = await Promise.all([
    prisma.shotView.groupBy({ by: ["shotId"], where: { shotId: { in: ids } }, _avg: { watchedMs: true } }),
    userId ? prisma.follow.findMany({ where: { followerId: userId, status: "ACCEPTED" }, select: { followingId: true } }) : Promise.resolve([]),
    userId
      ? prisma.shotLike.findMany({ where: { userId }, take: 300, select: { shot: { select: { authorId: true, animeId: true } } } })
      : Promise.resolve([] as { shot: { authorId: string; animeId: string | null } | null }[]),
  ]);
  const avgWatch = new Map(watch.map(w => [w.shotId, w._avg.watchedMs ?? 0]));
  const followSet = new Set(follows.map(f => f.followingId));
  const engAuthors = new Set<string>();
  const engAnime = new Set<string>();
  for (const r of engRows) {
    if (r.shot?.authorId) engAuthors.add(r.shot.authorId);
    if (r.shot?.animeId) engAnime.add(r.shot.animeId);
  }

  // Stage 2-5 — score every candidate.
  const now = Date.now();
  const scored = pool.map(s => {
    const likes = s._count.likes, comments = s._count.comments, saves = s._count.saves;
    const views = Math.max(s.viewCount, likes + saves + comments, 1);
    const weightedEng = RANK.wLike * likes + RANK.wComment * comments + RANK.wSave * saves;
    const engRate = (weightedEng + RANK.priorMean * RANK.priorC) / (views + RANK.priorC);

    const dur = s.durationMs ?? 0;
    const wt = dur > 0 ? Math.max(0, Math.min(1.5, (avgWatch.get(s.id) ?? 0) / dur)) : 0;
    const watchMul = dur > 0 ? 0.5 + wt : 1; // neutral when we have no duration/watch data
    const quality = engRate * watchMul;

    const ageH = Math.max(0, (now - s.createdAt.getTime()) / 3_600_000);
    const gravity = 1 / Math.pow(ageH + 2, RANK.gravity);
    const testBoost = ageH < RANK.testMaxAgeH && s.viewCount < RANK.testMaxViews ? RANK.testBoost : 1;

    let aff = 1;
    if (userId) {
      if (s.authorId === userId) aff *= RANK.ownShot;
      else {
        if (followSet.has(s.authorId)) aff *= RANK.affFollow;
        else if (engAuthors.has(s.authorId)) aff *= RANK.affEngAuthor;
        if (s.animeId && engAnime.has(s.animeId)) aff *= RANK.affTopic;
      }
    }
    let integrity = 1;
    if (s.sourceProvider) integrity *= RANK.demoteRepost;
    if (!s.thumbnailUrl) integrity *= RANK.demoteNoThumb;

    return { shot: s, score: quality * gravity * testBoost * aff * integrity, ageH, views: s.viewCount };
  });

  // Stage 6 — rerank with diversity (per-author cap, no back-to-back author) +
  // ε-greedy exploration (reserve a slice for fresh/low-exposure shots).
  const exploitSlots = limit - Math.round(limit * RANK.exploreFraction);
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  const pickedIds = new Set<string>();
  const authorCount = new Map<string, number>();
  let lastAuthor = "";
  const canPlace = (e: typeof scored[number]) =>
    e.shot.authorId !== lastAuthor && (authorCount.get(e.shot.authorId) ?? 0) < RANK.perAuthorCap;
  const place = (e: typeof scored[number]) => {
    picked.push(e); pickedIds.add(e.shot.id);
    authorCount.set(e.shot.authorId, (authorCount.get(e.shot.authorId) ?? 0) + 1);
    lastAuthor = e.shot.authorId;
  };

  for (const e of byScore) { if (picked.length >= exploitSlots) break; if (!pickedIds.has(e.shot.id) && canPlace(e)) place(e); }
  const explore = scored.filter(e => !pickedIds.has(e.shot.id)).sort((a, b) => a.ageH - b.ageH || a.views - b.views);
  for (const e of explore) { if (picked.length >= limit) break; if (canPlace(e)) place(e); }
  if (picked.length < limit) { // diversity left us short → backfill ignoring caps
    for (const e of byScore) { if (picked.length >= limit) break; if (!pickedIds.has(e.shot.id)) place(e); }
  }

  const data = await decorate(picked.map(p => p.shot), userId);
  const nextCursor = data.length > 0 ? encodeSeen([...seen, ...data.map(d => d.id)]) : null;
  return { data, meta: { nextCursor } };
}

// ─── getSaved (the viewer's bookmarked shots, newest-saved-first) ─────────────

export async function getSaved(userId: string, cursor?: string, limit = 12) {
  const saves = await prisma.shotSave.findMany({
    where: {
      userId,
      shot: { deletedAt: null },
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: { shot: { include: shotInclude } },
  });
  const hasMore = saves.length > limit;
  const slice = hasMore ? saves.slice(0, limit) : saves;
  const data = await decorate(slice.map(s => s.shot), userId);
  const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;
  return { data, meta: { nextCursor } };
}

// ─── getUserShots ─────────────────────────────────────────────────────────────

export async function getUserShots(authorId: string, viewerId?: string, cursor?: string, limit = 12) {
  const shots = await prisma.shot.findMany({
    where: {
      authorId,
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: shotInclude,
  });

  const hasMore = shots.length > limit;
  const slice = hasMore ? shots.slice(0, limit) : shots;
  const data = await decorate(slice, viewerId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── save / unsave (idempotent) ───────────────────────────────────────────────

export async function saveShot(userId: string, shotId: string) {
  const shot = await prisma.shot.findUnique({ where: { id: shotId }, select: { id: true, deletedAt: true } });
  if (!shot || shot.deletedAt) throw notFound("Shot not found");
  await prisma.shotSave.upsert({ where: { userId_shotId: { userId, shotId } }, create: { userId, shotId }, update: {} });
  const saves = await prisma.shotSave.count({ where: { shotId } });
  return { saved: true, saves };
}

export async function unsaveShot(userId: string, shotId: string) {
  await prisma.shotSave.deleteMany({ where: { userId, shotId } });
  const saves = await prisma.shotSave.count({ where: { shotId } });
  return { saved: false, saves };
}

// ─── createShot ───────────────────────────────────────────────────────────────

export async function createShot(authorId: string, dto: CreateShotDto) {
  const shot = await prisma.shot.create({
    data: {
      authorId,
      videoUrl: dto.videoUrl,
      ...(dto.thumbnailUrl ? { thumbnailUrl: dto.thumbnailUrl } : {}),
      ...(dto.caption ? { caption: dto.caption } : {}),
      ...(dto.durationMs ? { durationMs: dto.durationMs } : {}),
      ...(dto.animeId ? { animeId: dto.animeId } : {}),
    },
    include: shotInclude,
  });
  addReputation(authorId, "post_created").catch(console.error);
  // First-Shot badge (first-time action only)
  void (async () => {
    const n = await prisma.shot.count({ where: { authorId, deletedAt: null } });
    if (n === 1) await (await import("../../lib/badges")).awardBadge(authorId, "FIRST_SHOT");
  })().catch(() => {});
  return { ...shot, isLikedByMe: false, isSavedByMe: false, authorFollowedByMe: false };
}

// ─── deleteShot (author only, soft delete) ────────────────────────────────────

export async function deleteShot(userId: string, shotId: string) {
  const shot = await prisma.shot.findUnique({ where: { id: shotId } });
  if (!shot || shot.deletedAt) throw notFound("Shot not found");
  if (shot.authorId !== userId) throw forbidden("You can only delete your own shots");
  await prisma.shot.update({ where: { id: shotId }, data: { deletedAt: new Date() } });
}

// ─── like / unlike (idempotent) ───────────────────────────────────────────────

export async function likeShot(userId: string, shotId: string) {
  const shot = await prisma.shot.findUnique({ where: { id: shotId }, select: { id: true, deletedAt: true } });
  if (!shot || shot.deletedAt) throw notFound("Shot not found");
  await prisma.shotLike.upsert({
    where: { userId_shotId: { userId, shotId } },
    create: { userId, shotId },
    update: {},
  });
  const likes = await prisma.shotLike.count({ where: { shotId } });
  return { likes };
}

export async function unlikeShot(userId: string, shotId: string) {
  await prisma.shotLike.deleteMany({ where: { userId, shotId } });
  const likes = await prisma.shotLike.count({ where: { shotId } });
  return { likes };
}

// ─── comments ─────────────────────────────────────────────────────────────────

const commentInclude = {
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verifiedKind: true } },
  _count: { select: { likes: true } },
} as const;

export async function listComments(shotId: string, userId?: string, limit = 200) {
  const shot = await prisma.shot.findUnique({ where: { id: shotId }, select: { authorId: true } });
  const comments = await prisma.shotComment.findMany({
    where: { shotId, deletedAt: null },
    take: limit,
    orderBy: { createdAt: "asc" }, // chronological; the client builds + sorts the tree (pinned/newest first)
    include: commentInclude,
  });

  let liked = new Set<string>();
  if (userId && comments.length) {
    const rows = await prisma.shotCommentLike.findMany({
      where: { userId, commentId: { in: comments.map((c) => c.id) } },
      select: { commentId: true },
    });
    liked = new Set(rows.map((r) => r.commentId));
  }

  const data = comments.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    authorId: c.authorId,
    parentId: c.parentId,
    pinned: c.pinnedAt != null,
    isAuthor: c.authorId === shot?.authorId,
    likeCount: c._count.likes,
    likedByMe: liked.has(c.id),
    author: c.author,
  }));
  return { data, meta: { nextCursor: null } };
}

export async function createComment(userId: string, shotId: string, body: string, parentId?: string) {
  const text = body.trim();
  if (!text) throw badRequest("Comment can't be empty");
  if (text.length > 1000) throw badRequest("Comment too long");
  const shot = await prisma.shot.findUnique({ where: { id: shotId }, select: { id: true, authorId: true, deletedAt: true } });
  if (!shot || shot.deletedAt) throw notFound("Shot not found");

  // A reply must point at a real comment on this same shot. Only one level of
  // nesting — replying to a reply attaches to its top-level parent.
  let resolvedParentId: string | undefined;
  if (parentId) {
    const parent = await prisma.shotComment.findUnique({ where: { id: parentId }, select: { shotId: true, parentId: true } });
    if (!parent || parent.shotId !== shotId) throw badRequest("Invalid parent comment");
    resolvedParentId = parent.parentId ?? parentId;
  }

  const comment = await prisma.shotComment.create({
    data: { shotId, authorId: userId, body: text, parentId: resolvedParentId ?? null },
    include: commentInclude,
  });

  // Notify the shot author (not on self-comment).
  if (shot.authorId !== userId) {
    createNotification({
      recipientId: shot.authorId,
      type: NotificationType.SYSTEM,
      payload: {
        message: `${comment.author.displayName ?? comment.author.username} commented on your shot`,
        link: `/shots`, shotId,
        actorUsername: comment.author.username,
        actorDisplayName: comment.author.displayName,
        actorAvatarUrl: comment.author.avatarUrl ?? null,
        preview: text.slice(0, 120),
      },
    }).catch(() => {});
  }
  return { comment };
}

export async function deleteComment(userId: string, commentId: string) {
  const comment = await prisma.shotComment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, deletedAt: true, shot: { select: { authorId: true } } },
  });
  if (!comment || comment.deletedAt) throw notFound("Comment not found");
  // Comment author OR the shot owner can delete.
  if (comment.authorId !== userId && comment.shot.authorId !== userId) {
    throw forbidden("You can't delete this comment");
  }
  await prisma.shotComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
}

export async function likeComment(userId: string, commentId: string) {
  const c = await prisma.shotComment.findUnique({ where: { id: commentId }, select: { id: true, deletedAt: true } });
  if (!c || c.deletedAt) throw notFound("Comment not found");
  await prisma.shotCommentLike.upsert({
    where: { userId_commentId: { userId, commentId } },
    create: { userId, commentId },
    update: {},
  });
  return { liked: true, likeCount: await prisma.shotCommentLike.count({ where: { commentId } }) };
}

export async function unlikeComment(userId: string, commentId: string) {
  await prisma.shotCommentLike.deleteMany({ where: { userId, commentId } });
  return { liked: false, likeCount: await prisma.shotCommentLike.count({ where: { commentId } }) };
}

/** Pin/unpin a comment on a shot — only the shot's author may do this. */
export async function pinComment(userId: string, commentId: string, pinned: boolean) {
  const c = await prisma.shotComment.findUnique({
    where: { id: commentId },
    select: { id: true, deletedAt: true, shot: { select: { authorId: true } } },
  });
  if (!c || c.deletedAt) throw notFound("Comment not found");
  if (c.shot.authorId !== userId) throw forbidden("Only the shot author can pin comments");
  await prisma.shotComment.update({ where: { id: commentId }, data: { pinnedAt: pinned ? new Date() : null } });
  return { pinned };
}

// ─── view counting (see docs/shots-view-counting.md) ─────────────────────────
// Reels-style "it played" qualification happens client-side; here we enforce the
// honesty guards: one counted view per (shot, viewer) per UTC day, never the
// author's own view. The unique constraint on ShotView is the dedup +
// idempotency mechanism, so a refresh/loop/replay within the day is a no-op and
// no Redis set or queue is needed.
export async function recordView(
  shotId: string,
  opts: { userId?: string; viewerKey: string; watchedMs?: number },
) {
  const shot = await prisma.shot.findFirst({
    where: { id: shotId, deletedAt: null },
    select: { id: true, authorId: true, viewCount: true },
  });
  if (!shot) throw notFound("Shot not found");

  // Authed users dedupe by user id (across devices); anon by their device key.
  const viewerKey = opts.userId ? `u:${opts.userId}` : `a:${opts.viewerKey}`;

  // Never count the creator watching their own shot.
  if (opts.userId && opts.userId === shot.authorId) {
    return { viewCount: shot.viewCount, counted: false };
  }

  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const watchedMs = Math.max(0, Math.min(opts.watchedMs ?? 0, 10 * 60 * 1000));

  try {
    // Insert the ledger row + bump the denormalized counter atomically. If the
    // viewer already counted today, the unique constraint throws (P2002) and the
    // increment never runs — the count cannot be inflated by replays/refreshes.
    const [, updated] = await prisma.$transaction([
      prisma.shotView.create({
        data: { shotId, viewerKey, userId: opts.userId ?? null, day, watchedMs },
      }),
      prisma.shot.update({
        where: { id: shotId },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      }),
    ]);
    return { viewCount: updated.viewCount, counted: true };
  } catch (err: unknown) {
    // P2002 = already counted for this (shot, viewer, day) → idempotent no-op.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { viewCount: shot.viewCount, counted: false };
    }
    throw err;
  }
}
