/**
 * Manga sync service — persists Jikan /manga payloads into the local Postgres
 * catalog. Mirrors modules/anime/animeSync.service.ts:
 *  - slug is set once and never changed (SEO).
 *  - A full upsert clears isStub and stamps lastSyncedAt; a stub upsert never
 *    downgrades an existing full row back to stub.
 *  - Shares the SyncJob queue + Jikan token bucket with anime; manga jobs run
 *    at LOWER priority so the anime pipeline always wins the shared budget.
 */
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { generateSlug } from "../../lib/slug";
import type { JikanManga } from "../../lib/catalog/jikanClient";
import {
  computeMangaSyncPriority,
  mapMangaGenres,
  mapMangaScalars,
} from "../../lib/catalog/manga.mapper";
import type { MappedGenre } from "../../lib/catalog/jikan.mapper";
import { SYNC_JOB, enqueueSyncJob } from "../anime/syncQueue.service";

// Manga full-detail syncs sit BELOW anime episodes (-1) in the shared queue.
export const MANGA_FULL_PRIORITY = -2;

// ─── Slug ────────────────────────────────────────────────────────────────────

/** SEO slug from the English title (fallback: default title); collision →
 *  append -{malId}. Only ever called when the row has no slug yet. */
async function uniqueMangaSlug(
  title: string,
  titleEnglish: string | null,
  malId: number,
): Promise<string> {
  const base = generateSlug(titleEnglish || title) || `manga-${malId}`;
  const taken = await prisma.manga.findUnique({ where: { slug: base }, select: { malId: true } });
  if (!taken || taken.malId === malId) return base;
  return `${base}-${malId}`;
}

// ─── Genre upserts (shared Genre table — same fallback as animeSync) ────────

async function upsertGenres(genres: MappedGenre[]): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  for (const g of genres) {
    try {
      out.push(
        await prisma.genre.upsert({
          where: { name: g.name },
          create: { name: g.name, malId: g.malId, type: g.type },
          // Anime and manga share most MAL genre ids; when they diverge for the
          // same name, keep the id already stored (don't churn it per-medium).
          update: { type: g.type },
          select: { id: true },
        }),
      );
    } catch {
      const existing = await prisma.genre.findUnique({ where: { malId: g.malId }, select: { id: true } });
      if (existing) out.push(existing);
    }
  }
  return out;
}

function invalidateMangaCache(malId: number, slug: string | null): void {
  cache.del(`manga:${malId}`);
  if (slug) cache.del(`manga:slug:${slug}`);
  cache.delPattern("manga:browse:");
}

// ─── Enqueue helpers ─────────────────────────────────────────────────────────

/** Full-detail sync for one manga, deduped; skips fresh non-stub rows. */
export async function enqueueMangaFullSync(
  malId: number,
  opts?: { priority?: number; force?: boolean },
): Promise<{ id: string } | null> {
  if (!opts?.force) {
    const row = await prisma.manga.findUnique({
      where: { malId },
      select: { isStub: true, lastSyncedAt: true },
    });
    const freshCutoff = Date.now() - 7 * 24 * 60 * 60_000;
    if (row && !row.isStub && row.lastSyncedAt && row.lastSyncedAt.getTime() > freshCutoff) {
      return null;
    }
  }
  return enqueueSyncJob(
    SYNC_JOB.MANGA_FULL,
    { malId },
    { dedupeKey: `${SYNC_JOB.MANGA_FULL}:${malId}`, priority: opts?.priority ?? MANGA_FULL_PRIORITY },
  );
}

/** Stale-refresh batch per priority tier (mirrors enqueueStaleRefreshBatch). */
export async function enqueueStaleMangaRefreshBatch(
  priority: "HOT" | "NORMAL" | "COLD",
  olderThanMs: number,
  batchMax: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await prisma.manga.findMany({
    where: {
      syncPriority: priority,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
      syncFailCount: { lt: 5 },
    },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: batchMax,
    select: { malId: true },
  });

  let enqueued = 0;
  for (const r of rows) {
    const job = await enqueueSyncJob(
      SYNC_JOB.MANGA_FULL,
      { malId: r.malId },
      { dedupeKey: `${SYNC_JOB.MANGA_FULL}:${r.malId}`, priority: MANGA_FULL_PRIORITY },
    );
    if (job) enqueued++;
  }
  return enqueued;
}

// ─── Full upsert (/manga/{id}/full payload) ──────────────────────────────────

export async function upsertMangaFromJikan(jikanManga: JikanManga) {
  const scalars = mapMangaScalars(jikanManga);
  const syncPriority = computeMangaSyncPriority(scalars);

  const existing = await prisma.manga.findUnique({
    where: { malId: scalars.malId },
    select: { id: true, slug: true },
  });

  const slug = existing?.slug ?? (await uniqueMangaSlug(scalars.title, scalars.titleEnglish, scalars.malId));

  const genreRecords = await upsertGenres(mapMangaGenres(jikanManga));

  const syncFields = {
    lastSyncedAt: new Date(),
    syncPriority,
    syncFailCount: 0,
    isStub: false,
  };

  const manga = await prisma.manga.upsert({
    where: { malId: scalars.malId },
    create: { ...scalars, slug, ...syncFields },
    update: { ...scalars, ...syncFields, ...(existing && !existing.slug ? { slug } : {}) },
  });

  await prisma.$transaction([
    prisma.mangaGenre.deleteMany({ where: { mangaId: manga.id } }),
    prisma.mangaGenre.createMany({
      data: genreRecords.map((g) => ({ mangaId: manga.id, genreId: g.id })),
      skipDuplicates: true,
    }),
  ]);

  invalidateMangaCache(scalars.malId, manga.slug);
  return manga;
}

// ─── Stub upsert (search / list payloads) ────────────────────────────────────

export async function upsertMangaStubFromSearchResult(jikanManga: JikanManga) {
  const scalars = mapMangaScalars(jikanManga);

  const existing = await prisma.manga.findUnique({
    where: { malId: scalars.malId },
    select: { id: true, slug: true, isStub: true, lastSyncedAt: true },
  });

  // A full row already exists — list payloads are weaker data, don't touch it.
  if (existing && !existing.isStub && existing.lastSyncedAt) return existing;

  const slug = existing?.slug ?? (await uniqueMangaSlug(scalars.title, scalars.titleEnglish, scalars.malId));

  const manga = await prisma.manga.upsert({
    where: { malId: scalars.malId },
    create: { ...scalars, slug, isStub: true },
    update: { ...scalars, ...(existing && !existing.slug ? { slug } : {}) },
  });

  // List payloads still carry genres — persist them so filtering works before
  // the full sync lands.
  const genreRecords = await upsertGenres(mapMangaGenres(jikanManga));
  if (genreRecords.length) {
    await prisma.$transaction([
      prisma.mangaGenre.deleteMany({ where: { mangaId: manga.id } }),
      prisma.mangaGenre.createMany({
        data: genreRecords.map((g) => ({ mangaId: manga.id, genreId: g.id })),
        skipDuplicates: true,
      }),
    ]);
  }

  invalidateMangaCache(scalars.malId, manga.slug);
  return manga;
}

// ─── Failure bookkeeping ─────────────────────────────────────────────────────

export async function recordMangaSyncFailure(malId: number): Promise<void> {
  try {
    const row = await prisma.manga.update({
      where: { malId },
      data: { syncFailCount: { increment: 1 } },
      select: { syncFailCount: true },
    });
    if (row.syncFailCount >= 5) {
      await prisma.manga.update({ where: { malId }, data: { syncPriority: "COLD" } });
    }
  } catch {
    // Row may not exist yet — nothing to track.
  }
}
