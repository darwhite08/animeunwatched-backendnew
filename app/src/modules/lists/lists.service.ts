import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import type { UpsertEntryDto } from "./lists.schema";

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── getUserList ──────────────────────────────────────────────────────────────

export async function getUserList(
  username: string,
  status?: string,
  sort?: string,
  page = 1,
  limit = 20,
) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw notFound("User not found");

  const { skip, take } = paginate(page, limit);

  const validStatuses = ["PLAN_TO_WATCH", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED"] as const;
  type WatchStatus = (typeof validStatuses)[number];

  const statusFilter =
    status && validStatuses.includes(status as WatchStatus)
      ? (status as WatchStatus)
      : undefined;

  const orderBy =
    sort === "score"
      ? { score: "desc" as const }
      : sort === "title"
        ? { anime: { title: "asc" as const } }
        : { updatedAt: "desc" as const };

  const where = {
    userId: user.id,
    ...(statusFilter ? { status: statusFilter } : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.listEntry.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        anime: {
          include: {
            genres: { include: { genre: true } },
            studios: { include: { studio: true } },
          },
        },
      },
    }),
    prisma.listEntry.count({ where }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── upsertEntry ─────────────────────────────────────────────────────────────

export async function upsertEntry(userId: string, animeId: string, dto: UpsertEntryDto) {
  const anime = await prisma.anime.findUnique({ where: { id: animeId } });
  if (!anime) throw notFound("Anime not found");

  const entry = await prisma.listEntry.upsert({
    where: { userId_animeId: { userId, animeId } },
    create: {
      userId,
      animeId,
      status: dto.status,
      score: dto.score,
      episodesSeen: dto.episodesSeen ?? 0,
      startedAt: dto.startedAt,
      finishedAt: dto.finishedAt,
      notes: dto.notes,
    },
    update: {
      status: dto.status,
      ...(dto.score !== undefined ? { score: dto.score } : {}),
      ...(dto.episodesSeen !== undefined ? { episodesSeen: dto.episodesSeen } : {}),
      ...(dto.startedAt !== undefined ? { startedAt: dto.startedAt } : {}),
      ...(dto.finishedAt !== undefined ? { finishedAt: dto.finishedAt } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    },
  });

  return { entry };
}

// ─── deleteEntry ─────────────────────────────────────────────────────────────

export async function deleteEntry(userId: string, animeId: string) {
  const entry = await prisma.listEntry.findUnique({
    where: { userId_animeId: { userId, animeId } },
  });
  if (!entry) throw notFound("List entry not found");

  await prisma.listEntry.delete({ where: { userId_animeId: { userId, animeId } } });
}
