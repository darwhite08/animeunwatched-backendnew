import { prisma } from "../../config/prisma";
import { notFound, forbidden, conflict } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { broadcastReviewCreated } from "../../realtime/broadcast";
import type { CreateReviewDto, UpdateReviewDto } from "./reviews.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const reviewInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
  _count: {
    select: { likes: true },
  },
} as const;

// ─── Pagination helpers ───────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── getAnimeReviews ──────────────────────────────────────────────────────────

export async function getAnimeReviews(
  animeId: string,
  sort: "helpful" | "recent" = "recent",
  page = 1,
  limit = 20,
) {
  const { skip, take } = paginate(page, limit);

  const orderBy =
    sort === "helpful"
      ? { likes: { _count: "desc" as const } }
      : { createdAt: "desc" as const };

  const [data, total] = await prisma.$transaction([
    prisma.review.findMany({
      where: { animeId },
      skip,
      take,
      orderBy,
      include: reviewInclude,
    }),
    prisma.review.count({ where: { animeId } }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(authorId: string, dto: CreateReviewDto) {
  const existing = await prisma.review.findUnique({
    where: { animeId_authorId: { animeId: dto.animeId, authorId } },
  });
  if (existing) throw conflict("You have already reviewed this anime");

  const review = await prisma.review.create({
    data: {
      animeId: dto.animeId,
      authorId,
      score: dto.score,
      body: dto.body,
      hasSpoilers: dto.hasSpoilers ?? false,
    },
    include: reviewInclude,
  });
  addReputation(authorId, "review_posted").catch(console.error);

  // Realtime: broadcast to anyone viewing this anime page (best-effort)
  try {
    const animeRow = await prisma.anime.findUnique({ where: { id: dto.animeId }, select: { malId: true } });
    if (animeRow) broadcastReviewCreated(animeRow.malId, review);
  } catch { /* fire-and-forget */ }

  return { review };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(id: string, userId: string, dto: UpdateReviewDto) {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) throw notFound("Review not found");
  if (review.authorId !== userId) throw forbidden("Not allowed to edit this review");

  const updated = await prisma.review.update({
    where: { id },
    data: {
      ...(dto.score !== undefined ? { score: dto.score } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.hasSpoilers !== undefined ? { hasSpoilers: dto.hasSpoilers } : {}),
    },
    include: reviewInclude,
  });

  return { review: updated };
}

// ─── deleteReview ─────────────────────────────────────────────────────────────

export async function deleteReview(id: string, userId: string, role: string) {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) throw notFound("Review not found");

  const canDelete = review.authorId === userId || role === "MOD" || role === "ADMIN";
  if (!canDelete) throw forbidden("Not allowed to delete this review");

  await prisma.review.delete({ where: { id } });
}

// ─── like ─────────────────────────────────────────────────────────────────────

export async function like(userId: string, reviewId: string) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw notFound("Review not found");

  const existingLike = await prisma.reviewLike.findUnique({
    where: { userId_reviewId: { userId, reviewId } },
    select: { userId: true },
  });

  await prisma.reviewLike.upsert({
    where: { userId_reviewId: { userId, reviewId } },
    create: { userId, reviewId },
    update: {},
  });

  // Only award reputation once per unique like
  if (!existingLike) {
    addReputation(review.authorId, "review_liked").catch(console.error);
  }
}

// ─── unlike ───────────────────────────────────────────────────────────────────

export async function unlike(userId: string, reviewId: string) {
  await prisma.reviewLike.deleteMany({ where: { userId, reviewId } });
}

// ─── listReviews ──────────────────────────────────────────────────────────────

export async function listReviews(sort = "recent", page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const orderBy =
    sort === "helpful" ? { likes: { _count: "desc" as const } } :
    sort === "highest" ? { score: "desc" as const } :
    sort === "lowest"  ? { score: "asc"  as const } :
    { createdAt: "desc" as const };

  const [data, total] = await prisma.$transaction([
    prisma.review.findMany({
      skip, take: limit,
      orderBy,
      include: {
        ...reviewInclude,
        anime: { select: { id: true, malId: true, title: true, imageUrl: true } },
      },
    }),
    prisma.review.count(),
  ]);

  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}
