import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { searchManga, getMangaMalIds } from "../../lib/anilist";
import { buildSearchText } from "../../lib/searchText";
import type { AddMangaDto, UpdateMangaDto } from "./readlist.schema";

export async function search(q: string) {
  // Still AniList-shaped (anilistId + denormalized fields) because the live web
  // add-modal consumes exactly this. Clients migrating to the local catalog
  // should use GET /manga/search + POST /readlist { mangaId } instead.
  return { data: await searchManga(q) };
}

export async function getByUsername(usernameOrSlug: string) {
  // The profile URL uses the slug; the API also accepts the raw username.
  const user = await prisma.user.findFirst({
    where: { OR: [{ username: usernameOrSlug }, { slug: usernameOrSlug }] },
    select: { id: true },
  });
  if (!user) throw notFound("User not found");
  const data = await prisma.mangaEntry.findMany({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  return { data };
}

export async function getMine(userId: string) {
  const data = await prisma.mangaEntry.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return { data };
}

export async function add(userId: string, dto: AddMangaDto) {
  // ── Catalog path (preferred): metadata comes from the local Manga row ──
  if (dto.mangaId) {
    const manga = await prisma.manga.findUnique({
      where: { id: dto.mangaId },
      select: {
        id: true, title: true, titleEnglish: true, imageUrl: true,
        type: true, chapters: true, authors: true, genres: { include: { genre: true } },
      },
    });
    if (!manga) throw notFound("Manga not found");

    // Idempotent: re-adding keeps the user's progress.
    const entry = await prisma.mangaEntry.upsert({
      where: { userId_mangaId: { userId, mangaId: manga.id } },
      create: {
        userId,
        mangaId: manga.id,
        title: manga.titleEnglish || manga.title,
        coverUrl: manga.imageUrl,
        author: manga.authors[0] ?? null,
        format: manga.type,
        totalChapters: manga.chapters,
        genre: manga.genres[0]?.genre.name ?? null,
        status: dto.status ?? "PLAN_TO_READ",
      },
      update: {},
    });
    return { entry };
  }

  // ── Legacy AniList path (current web add-modal) ──
  if (!dto.anilistId || !dto.title) throw badRequest("Invalid manga payload");
  const entry = await prisma.mangaEntry.upsert({
    where: { userId_anilistId: { userId, anilistId: dto.anilistId } },
    create: {
      userId,
      anilistId: dto.anilistId,
      title: dto.title,
      coverUrl: dto.coverUrl ?? null,
      author: dto.author ?? null,
      format: dto.format ?? null,
      totalChapters: dto.totalChapters ?? null,
      genre: dto.genre ?? null,
      status: dto.status ?? "PLAN_TO_READ",
    },
    update: {},
  });
  return { entry };
}

export async function update(userId: string, id: string, dto: UpdateMangaDto) {
  const existing = await prisma.mangaEntry.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw notFound("Entry not found");

  const data: { status?: string; progress?: number; volumesRead?: number; score?: number | null } = {};
  if (dto.status !== undefined) data.status = dto.status;
  if (dto.progress !== undefined) data.progress = dto.progress;
  if (dto.volumesRead !== undefined) data.volumesRead = dto.volumesRead;
  if (dto.score !== undefined) data.score = dto.score ?? null;
  // Marking complete with a known length auto-fills progress.
  if (dto.status === "COMPLETED" && existing.totalChapters && dto.progress === undefined) {
    data.progress = existing.totalChapters;
  }

  const entry = await prisma.mangaEntry.update({ where: { id }, data });
  return { entry };
}

export async function remove(userId: string, id: string) {
  const existing = await prisma.mangaEntry.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw notFound("Entry not found");
  await prisma.mangaEntry.delete({ where: { id } });
}

// ─── Legacy backfill: AniList-keyed entries → local Manga catalog ────────────
// One-off boot job (jobs/index.ts). Idempotent: only touches rows where
// mangaId IS NULL. For each distinct anilistId it resolves the MAL id via one
// batched AniList query, stubs a Manga row from the entry's cached metadata
// (the sync queue fills full detail), and links the entry.

export async function backfillCatalogLinks(): Promise<{ scanned: number; linked: number }> {
  const orphans = await prisma.mangaEntry.findMany({
    where: { mangaId: null, anilistId: { not: null } },
    select: { id: true, anilistId: true, title: true, coverUrl: true, totalChapters: true, format: true },
  });
  if (!orphans.length) return { scanned: 0, linked: 0 };

  const anilistIds = [...new Set(orphans.map((o) => o.anilistId as number))];
  let malByAnilist: Map<number, number | null>;
  try {
    malByAnilist = await getMangaMalIds(anilistIds);
  } catch (err) {
    console.warn("[readlist-backfill] AniList lookup failed, will retry next boot:", (err as Error).message);
    return { scanned: orphans.length, linked: 0 };
  }

  let linked = 0;
  for (const o of orphans) {
    const malId = malByAnilist.get(o.anilistId as number);
    if (!malId) continue; // AniList-only title with no MAL counterpart — stays legacy

    try {
      const manga = await prisma.manga.upsert({
        where: { malId },
        create: {
          malId,
          title: o.title,
          searchText: buildSearchText({ title: o.title }),
          imageUrl: o.coverUrl,
          chapters: o.totalChapters,
          type: o.format,
          isStub: true,
        },
        update: {},
        select: { id: true },
      });
      await prisma.mangaEntry.update({ where: { id: o.id }, data: { mangaId: manga.id } });
      linked++;
      const { enqueueMangaFullSync } = await import("../manga/mangaSync.service");
      void enqueueMangaFullSync(malId).catch(() => {});
    } catch {
      // Unique (userId, mangaId) collision — two AniList entries mapping to the
      // same MAL title. Leave the duplicate unlinked; harmless.
    }
  }
  return { scanned: orphans.length, linked };
}
