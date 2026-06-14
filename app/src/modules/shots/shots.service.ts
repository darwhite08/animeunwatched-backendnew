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

// ─── getFeed (newest-first cursor feed; filter "following" = followed authors) ─

export async function getFeed(userId?: string, cursor?: string, limit = 10, filter?: "following") {
  let authorWhere = {};
  if (filter === "following") {
    if (!userId) return { data: [], meta: { nextCursor: null } };
    const follows = await prisma.follow.findMany({ where: { followerId: userId, status: "ACCEPTED" }, select: { followingId: true } });
    const ids = follows.map(f => f.followingId);
    if (ids.length === 0) return { data: [], meta: { nextCursor: null } };
    authorWhere = { authorId: { in: ids } };
  }
  const shots = await prisma.shot.findMany({
    where: {
      deletedAt: null,
      ...authorWhere,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
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
