import { prisma } from "../../config/prisma";
import { notFound, forbidden, badRequest } from "../../lib/errors";
import type {
  CreateActivityDto, CreateReplyDto, FeedQueryDto, RepostActivityDto,
} from "./activities.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const activityInclude = {
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, slug: true },
  },
  linkedAnime: {
    select: { id: true, malId: true, title: true, imageUrl: true },
  },
  repostOf: {
    include: {
      author: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, slug: true },
      },
      linkedAnime: {
        select: { id: true, malId: true, title: true, imageUrl: true },
      },
    },
  },
} as const;

/** Attach isLikedByMe / isRepostedByMe flags. */
async function withEngagementFlags<T extends { id: string }>(
  rows: T[],
  userId?: string,
): Promise<(T & { isLikedByMe: boolean; isRepostedByMe: boolean })[]> {
  if (!userId || rows.length === 0) {
    return rows.map(r => ({ ...r, isLikedByMe: false, isRepostedByMe: false }));
  }
  const ids = rows.map(r => r.id);
  const [likes, reposts] = await Promise.all([
    prisma.activityLike.findMany({
      where: { userId, activityId: { in: ids } },
      select: { activityId: true },
    }),
    prisma.activityRepost.findMany({
      where: { userId, activityId: { in: ids } },
      select: { activityId: true },
    }),
  ]);
  const likedSet    = new Set(likes.map(l => l.activityId));
  const repostedSet = new Set(reposts.map(r => r.activityId));
  return rows.map(r => ({
    ...r,
    isLikedByMe:    likedSet.has(r.id),
    isRepostedByMe: repostedSet.has(r.id),
  }));
}

// ─── createActivity ───────────────────────────────────────────────────────────

export async function createActivity(authorId: string, dto: CreateActivityDto) {
  if (dto.kind === "LIST_UPDATE") {
    const anime = await prisma.anime.findUnique({
      where: { id: dto.linkedAnimeId }, select: { id: true },
    });
    if (!anime) throw notFound("Anime not found");
  }
  if (dto.kind === "MESSAGE") {
    const recipient = await prisma.user.findUnique({
      where: { id: dto.wallOwnerId }, select: { id: true },
    });
    if (!recipient) throw notFound("Recipient not found");
  }

  const activity = await prisma.activity.create({
    data: {
      authorId,
      kind:          dto.kind,
      body:          (dto as { body?: string }).body ?? null,
      hasSpoiler:    dto.hasSpoiler ?? false,
      linkedAnimeId: (dto as { linkedAnimeId?: string }).linkedAnimeId ?? null,
      verb:          dto.kind === "LIST_UPDATE" ? dto.verb : null,
      episodeNumber: dto.kind === "LIST_UPDATE" ? dto.episodeNumber ?? null : null,
      score:         dto.kind === "LIST_UPDATE" ? dto.score ?? null : null,
      wallOwnerId:   dto.kind === "MESSAGE" ? dto.wallOwnerId : null,
    },
    include: activityInclude,
  });

  return { ...activity, isLikedByMe: false, isRepostedByMe: false };
}

// ─── getFeed ───────────────────────────────────────────────────────────────────

export async function getFeed(viewerId: string | undefined, q: FeedQueryDto) {
  // Build the author filter for following / global / profile.
  let where: Record<string, unknown> = {
    deletedAt: null,
    ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
  };

  if (q.type === "following") {
    if (!viewerId) throw forbidden("Sign in to view your following feed");
    const follows = await prisma.follow.findMany({
      where: { followerId: viewerId },
      select: { followingId: true },
    });
    const authorIds = [viewerId, ...follows.map(f => f.followingId)];
    where = { ...where, authorId: { in: authorIds } };
  } else if (q.type === "profile") {
    if (!q.userId) throw badRequest("type=profile requires userId");
    where = { ...where, authorId: q.userId };
  }
  // global → no extra author filter

  const rows = await prisma.activity.findMany({
    where,
    take: q.limit + 1,
    orderBy: { createdAt: "desc" },
    include: activityInclude,
  });

  const hasMore    = rows.length > q.limit;
  const slice      = hasMore ? rows.slice(0, q.limit) : rows;
  const data       = await withEngagementFlags(slice, viewerId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getActivity ───────────────────────────────────────────────────────────────

export async function getActivity(id: string, viewerId?: string) {
  const activity = await prisma.activity.findUnique({
    where: { id }, include: activityInclude,
  });
  if (!activity || activity.deletedAt !== null) throw notFound("Activity not found");
  const [withFlags] = await withEngagementFlags([activity], viewerId);
  return withFlags;
}

// ─── deleteActivity ───────────────────────────────────────────────────────────

export async function deleteActivity(id: string, authorId: string) {
  const activity = await prisma.activity.findUnique({
    where: { id }, select: { authorId: true, deletedAt: true },
  });
  if (!activity || activity.deletedAt !== null) throw notFound("Activity not found");
  if (activity.authorId !== authorId) throw forbidden("Not the author");
  await prisma.activity.update({
    where: { id }, data: { deletedAt: new Date() },
  });
  return { ok: true };
}

// ─── like / unlike ─────────────────────────────────────────────────────────────

export async function likeActivity(userId: string, activityId: string) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.activity.findUnique({
      where: { id: activityId }, select: { id: true, deletedAt: true, authorId: true },
    });
    if (!target || target.deletedAt !== null) throw notFound("Activity not found");

    try {
      await tx.activityLike.create({ data: { userId, activityId } });
      await tx.activity.update({
        where: { id: activityId },
        data:  { likeCount: { increment: 1 } },
      });
    } catch (err) {
      // Already liked — idempotent no-op.
      if ((err as { code?: string })?.code === "P2002") return { ok: true, alreadyLiked: true };
      throw err;
    }
    return { ok: true };
  });
}

export async function unlikeActivity(userId: string, activityId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.activityLike.findUnique({
      where: { userId_activityId: { userId, activityId } },
    });
    if (!existing) return { ok: true, alreadyUnliked: true };

    await tx.activityLike.delete({
      where: { userId_activityId: { userId, activityId } },
    });
    await tx.activity.update({
      where: { id: activityId },
      data:  { likeCount: { decrement: 1 } },
    });
    return { ok: true };
  });
}

// ─── repost / unrepost ────────────────────────────────────────────────────────

export async function repostActivity(userId: string, activityId: string, dto: RepostActivityDto) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.activity.findUnique({
      where: { id: activityId },
      select: { id: true, deletedAt: true, authorId: true, kind: true },
    });
    if (!target || target.deletedAt !== null) throw notFound("Activity not found");
    if (target.authorId === userId) throw badRequest("Cannot repost your own activity");

    // Create the user-facing repost Activity (visible in their followers' feeds).
    const repostActivity = await tx.activity.create({
      data: {
        authorId:   userId,
        kind:       "TEXT",
        body:       dto.body ?? null,
        repostOfId: activityId,
      },
      include: activityInclude,
    });

    // Join row — also denorms the count on the original.
    try {
      await tx.activityRepost.create({
        data: { userId, activityId, repostActivityId: repostActivity.id },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        // Already reposted — undo the new activity row and bail.
        await tx.activity.delete({ where: { id: repostActivity.id } });
        return { ok: true, alreadyReposted: true };
      }
      throw err;
    }

    await tx.activity.update({
      where: { id: activityId },
      data:  { repostCount: { increment: 1 } },
    });

    return repostActivity;
  });
}

export async function unrepostActivity(userId: string, activityId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.activityRepost.findUnique({
      where: { userId_activityId: { userId, activityId } },
    });
    if (!existing) return { ok: true, alreadyUnreposted: true };

    if (existing.repostActivityId) {
      await tx.activity.update({
        where: { id: existing.repostActivityId },
        data:  { deletedAt: new Date() },
      });
    }
    await tx.activityRepost.delete({
      where: { userId_activityId: { userId, activityId } },
    });
    await tx.activity.update({
      where: { id: activityId },
      data:  { repostCount: { decrement: 1 } },
    });
    return { ok: true };
  });
}

// ─── replies ──────────────────────────────────────────────────────────────────

const replyInclude = {
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, slug: true },
  },
} as const;

export async function createReply(authorId: string, activityId: string, dto: CreateReplyDto) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.activity.findUnique({
      where: { id: activityId }, select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt !== null) throw notFound("Activity not found");

    const reply = await tx.reply.create({
      data: {
        activityId,
        authorId,
        body:          dto.body,
        hasSpoiler:    dto.hasSpoiler ?? false,
        parentReplyId: dto.parentReplyId ?? null,
      },
      include: replyInclude,
    });

    await tx.activity.update({
      where: { id: activityId },
      data:  { replyCount: { increment: 1 } },
    });

    if (dto.parentReplyId) {
      await tx.reply.update({
        where: { id: dto.parentReplyId },
        data:  { replyCount: { increment: 1 } },
      });
    }

    return reply;
  });
}

export async function getReplies(activityId: string, cursor?: string, limit = 20) {
  const rows = await prisma.reply.findMany({
    where: {
      activityId,
      deletedAt: null,
      parentReplyId: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: replyInclude,
  });
  const hasMore    = rows.length > limit;
  const data       = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;
  return { data, meta: { nextCursor } };
}
