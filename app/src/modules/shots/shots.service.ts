import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import type { CreateShotDto } from "./shots.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const shotInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
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
    select: { likes: true },
  },
} as const;

/** Attach isLikedByMe flag to shots when userId is known */
async function withLikeStatus<T extends { id: string }>(shots: T[], userId?: string): Promise<(T & { isLikedByMe: boolean })[]> {
  if (!userId || shots.length === 0) {
    return shots.map(s => ({ ...s, isLikedByMe: false }));
  }
  const likes = await prisma.shotLike.findMany({
    where: { userId, shotId: { in: shots.map(s => s.id) } },
    select: { shotId: true },
  });
  const likedSet = new Set(likes.map((l: { shotId: string }) => l.shotId));
  return shots.map(s => ({ ...s, isLikedByMe: likedSet.has(s.id) }));
}

// ─── getFeed (newest-first cursor feed, same shape as posts/discover) ─────────

export async function getFeed(userId?: string, cursor?: string, limit = 10) {
  const shots = await prisma.shot.findMany({
    where: {
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: shotInclude,
  });

  const hasMore = shots.length > limit;
  const slice = hasMore ? shots.slice(0, limit) : shots;
  const data = await withLikeStatus(slice, userId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

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
  const data = await withLikeStatus(slice, viewerId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
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
  return { ...shot, isLikedByMe: false };
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
