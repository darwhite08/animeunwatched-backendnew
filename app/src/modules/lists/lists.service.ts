import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import { updateStreak } from "../../lib/streak";
import { createNotification, NotificationType } from "../../lib/notify";
import { addReputation } from "../../lib/reputation";
import { broadcastAnimeListChanged } from "../../realtime/broadcast";
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
  // Support both internal cuid and malId (the frontend maps anime.id = String(malId))
  const malIdNum = Number(animeId)
  const anime = isNaN(malIdNum)
    ? await prisma.anime.findUnique({ where: { id: animeId } })
    : (await prisma.anime.findFirst({ where: { malId: malIdNum } }))
      ?? await prisma.anime.findUnique({ where: { id: animeId } });
  if (!anime) throw notFound("Anime not found");

  // Always use the resolved internal cuid for DB operations
  const resolvedAnimeId = anime.id;

  const entry = await prisma.listEntry.upsert({
    where: { userId_animeId: { userId, animeId: resolvedAnimeId } },
    create: {
      userId,
      animeId: resolvedAnimeId,
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

  // Fire-and-forget streak update — list activity counts as daily engagement
  void updateStreak(userId).catch(() => {});

  // Realtime: anime detail page's user-stats counter updates live
  if (anime.malId) broadcastAnimeListChanged(anime.malId);

  // On COMPLETED status: check for milestone achievements
  if (dto.status === "COMPLETED") {
    void (async () => {
      try {
        const completedCount = await prisma.listEntry.count({ where: { userId, status: "COMPLETED" } });
        const milestones: Record<number, { badge: string; xp: number }> = {
          1:   { badge: "First Archive", xp: 100 },
          10:  { badge: "Decade Watcher", xp: 200 },
          25:  { badge: "Quarter Century", xp: 500 },
          50:  { badge: "Half-Hundred", xp: 1000 },
          100: { badge: "Centurion Watcher", xp: 2500 },
          250: { badge: "Legendary Archive", xp: 5000 },
          500: { badge: "Neural Oracle", xp: 10000 },
        };
        const milestone = milestones[completedCount];
        if (milestone) {
          await addReputation(userId, "achievement_unlocked").catch(() => {});
          await createNotification({
            recipientId: userId,
            type: NotificationType.ACHIEVEMENT,
            payload: {
              message: `Achievement unlocked: ${milestone.badge}! You've completed ${completedCount} anime.`,
              badge: milestone.badge,
              completedCount,
              xp: milestone.xp,
              link: "/streak",
            },
          });
        }
      } catch { /* never fail the main request */ }
    })();
  }

  return { entry };
}

// ─── deleteEntry ─────────────────────────────────────────────────────────────

export async function deleteEntry(userId: string, animeId: string) {
  // Resolve malId → internal cuid so delete works regardless of which ID the frontend sends
  let resolvedId = animeId
  const malIdNum = Number(animeId)
  if (!isNaN(malIdNum)) {
    const anime = await prisma.anime.findFirst({ where: { malId: malIdNum }, select: { id: true } })
    if (anime) resolvedId = anime.id
  }

  const entry = await prisma.listEntry.findUnique({
    where: { userId_animeId: { userId, animeId: resolvedId } },
  });
  if (!entry) throw notFound("List entry not found");

  await prisma.listEntry.delete({ where: { userId_animeId: { userId, animeId: resolvedId } } });
}
