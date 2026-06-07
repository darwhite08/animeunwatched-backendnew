/**
 * Anime sync service — persists Jikan payloads into the local Postgres
 * catalog. This is the ONLY module that writes sync data to Anime/Episode/
 * AnimeRelation rows.
 *
 * Invariants:
 *  - slug is set once (on create / first backfill) and never changed — SEO.
 *  - Kaiveron enrichment fields (kaiveronTags, waieScore, isFeatured,
 *    localImagePath) are NEVER written here.
 *  - A full upsert clears isStub and stamps lastSyncedAt; a stub upsert
 *    never downgrades an existing full row back to stub.
 */
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { generateSlug } from "../../lib/slug";
import { getAnimeEpisodesPage, type JikanAnime } from "../../lib/catalog/jikanClient";
import {
  computeSyncPriority,
  mapAnimeScalars,
  mapEpisode,
  mapGenres,
  mapRelations,
  mapStudios,
  type MappedGenre,
  type MappedStudio,
} from "../../lib/catalog/jikan.mapper";

// ─── SyncJobLog helper ────────────────────────────────────────────────────────

export async function logSyncJob(entry: {
  jobType: string;
  malId?: number | null;
  status: "success" | "failed" | "skipped";
  error?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  try {
    await prisma.syncJobLog.create({
      data: {
        jobType: entry.jobType,
        malId: entry.malId ?? null,
        status: entry.status,
        error: entry.error?.slice(0, 2000) ?? null,
        durationMs: entry.durationMs ?? null,
      },
    });
  } catch {
    // Observability must never break the sync itself.
  }
}

// ─── Slug ────────────────────────────────────────────────────────────────────

/** SEO slug from the English title (fallback: default title); collision →
 *  append -{malId}. Only ever called when the row has no slug yet. */
async function uniqueAnimeSlug(
  title: string,
  titleEnglish: string | null,
  malId: number,
): Promise<string> {
  const base = generateSlug(titleEnglish || title) || `anime-${malId}`;
  const taken = await prisma.anime.findUnique({ where: { slug: base }, select: { malId: true } });
  if (!taken || taken.malId === malId) return base;
  return `${base}-${malId}`;
}

// ─── Genre / studio upserts ──────────────────────────────────────────────────

async function upsertGenres(genres: MappedGenre[]): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  for (const g of genres) {
    try {
      out.push(
        await prisma.genre.upsert({
          where: { name: g.name },
          create: { name: g.name, malId: g.malId, type: g.type },
          update: { malId: g.malId, type: g.type },
          select: { id: true },
        }),
      );
    } catch {
      // malId unique collision (same MAL genre under a renamed label) —
      // fall back to the row already holding that malId.
      const existing = await prisma.genre.findUnique({ where: { malId: g.malId }, select: { id: true } });
      if (existing) out.push(existing);
    }
  }
  return out;
}

async function upsertStudios(studios: MappedStudio[]): Promise<Array<{ id: string; role: string }>> {
  const out: Array<{ id: string; role: string }> = [];
  for (const s of studios) {
    try {
      const row = await prisma.studio.upsert({
        where: { name: s.name },
        create: { name: s.name, malId: s.malId },
        update: { malId: s.malId },
        select: { id: true },
      });
      out.push({ id: row.id, role: s.role });
    } catch {
      const existing = await prisma.studio.findUnique({ where: { malId: s.malId }, select: { id: true } });
      if (existing) out.push({ id: existing.id, role: s.role });
    }
  }
  return out;
}

function invalidateAnimeCache(malId: number, slug: string | null): void {
  cache.del(`anime:${malId}`);
  if (slug) cache.del(`anime:slug:${slug}`);
  cache.delPattern("anime:browse:");
  cache.del("anime:trending");
}

// ─── Full upsert (/anime/{id}/full payload) ──────────────────────────────────

export async function upsertAnimeFromJikan(jikanAnime: JikanAnime) {
  const scalars = mapAnimeScalars(jikanAnime);
  const syncPriority = computeSyncPriority(scalars);

  const existing = await prisma.anime.findUnique({
    where: { malId: scalars.malId },
    select: { id: true, slug: true },
  });

  // Slug: create-only. Backfill pre-existing rows that never got one.
  const slug = existing?.slug ?? (await uniqueAnimeSlug(scalars.title, scalars.titleEnglish, scalars.malId));

  const genreRecords = await upsertGenres(mapGenres(jikanAnime));
  const studioRecords = await upsertStudios(mapStudios(jikanAnime));
  const relations = mapRelations(jikanAnime);

  // Resolve relation targets that already exist locally.
  const targetRows = relations.length
    ? await prisma.anime.findMany({
        where: { malId: { in: relations.map((r) => r.targetMalId) } },
        select: { id: true, malId: true },
      })
    : [];
  const targetByMalId = new Map(targetRows.map((t) => [t.malId, t.id]));

  const syncFields = {
    lastSyncedAt: new Date(),
    syncPriority,
    syncFailCount: 0,
    isStub: false,
  };

  const anime = await prisma.anime.upsert({
    where: { malId: scalars.malId },
    create: { ...scalars, slug, ...syncFields },
    // NOTE: no slug, no kaiveronTags/waieScore/isFeatured/localImagePath here.
    update: { ...scalars, ...syncFields, ...(existing && !existing.slug ? { slug } : {}) },
  });

  // Reconcile joins atomically (same pattern as the legacy upsertFromCatalog).
  await prisma.$transaction([
    prisma.animeGenre.deleteMany({ where: { animeId: anime.id } }),
    prisma.animeGenre.createMany({
      data: genreRecords.map((g) => ({ animeId: anime.id, genreId: g.id })),
      skipDuplicates: true,
    }),
    prisma.animeStudio.deleteMany({ where: { animeId: anime.id } }),
    prisma.animeStudio.createMany({
      data: studioRecords.map((s) => ({ animeId: anime.id, studioId: s.id, role: s.role })),
      skipDuplicates: true,
    }),
    prisma.animeRelation.deleteMany({ where: { sourceId: anime.id } }),
    prisma.animeRelation.createMany({
      data: relations.map((r) => ({
        sourceId: anime.id,
        targetMalId: r.targetMalId,
        targetId: targetByMalId.get(r.targetMalId) ?? null,
        relationType: r.relationType,
      })),
      skipDuplicates: true,
    }),
    // Other rows may reference THIS anime as an unresolved target — resolve them.
    prisma.animeRelation.updateMany({
      where: { targetMalId: scalars.malId, targetId: null },
      data: { targetId: anime.id },
    }),
  ]);

  invalidateAnimeCache(scalars.malId, anime.slug);
  return anime;
}

// ─── Stub upsert (search / list payloads) ────────────────────────────────────

export async function upsertStubFromSearchResult(jikanAnime: JikanAnime) {
  const scalars = mapAnimeScalars(jikanAnime);

  const existing = await prisma.anime.findUnique({
    where: { malId: scalars.malId },
    select: { id: true, slug: true, isStub: true, lastSyncedAt: true },
  });

  // A full row already exists — list payloads are weaker data, don't touch it.
  if (existing && !existing.isStub && existing.lastSyncedAt) return existing;

  const slug = existing?.slug ?? (await uniqueAnimeSlug(scalars.title, scalars.titleEnglish, scalars.malId));

  const anime = await prisma.anime.upsert({
    where: { malId: scalars.malId },
    create: { ...scalars, slug, isStub: true },
    update: { ...scalars, ...(existing && !existing.slug ? { slug } : {}) },
  });

  // List payloads still carry genres/studios — persist them so filtering works
  // before the full sync lands.
  const genreRecords = await upsertGenres(mapGenres(jikanAnime));
  const studioRecords = await upsertStudios(mapStudios(jikanAnime));
  if (genreRecords.length || studioRecords.length) {
    await prisma.$transaction([
      prisma.animeGenre.deleteMany({ where: { animeId: anime.id } }),
      prisma.animeGenre.createMany({
        data: genreRecords.map((g) => ({ animeId: anime.id, genreId: g.id })),
        skipDuplicates: true,
      }),
      prisma.animeStudio.deleteMany({ where: { animeId: anime.id } }),
      prisma.animeStudio.createMany({
        data: studioRecords.map((s) => ({ animeId: anime.id, studioId: s.id, role: s.role })),
        skipDuplicates: true,
      }),
    ]);
  }

  invalidateAnimeCache(scalars.malId, anime.slug);
  return anime;
}

// ─── Failure bookkeeping ─────────────────────────────────────────────────────

/** Bump syncFailCount on a failed full sync; 5+ consecutive failures demote
 *  the row to COLD so the scheduler stops hammering a dead malId. */
export async function recordSyncFailure(malId: number): Promise<void> {
  try {
    const row = await prisma.anime.update({
      where: { malId },
      data: { syncFailCount: { increment: 1 } },
      select: { syncFailCount: true },
    });
    if (row.syncFailCount >= 5) {
      await prisma.anime.update({ where: { malId }, data: { syncPriority: "COLD" } });
    }
  } catch {
    // Row may not exist yet (full sync of a brand-new malId failed) — nothing to track.
  }
}

export async function getAnimeIdByMalId(malId: number): Promise<string | null> {
  const row = await prisma.anime.findUnique({ where: { malId }, select: { id: true } });
  return row?.id ?? null;
}

// ─── Episodes ────────────────────────────────────────────────────────────────

/** Page through /anime/{malId}/episodes (100/page) and upsert. Returns the
 *  number of episodes written. */
export async function syncEpisodes(animeId: string, malId: number): Promise<number> {
  let page = 1;
  let written = 0;

  for (;;) {
    const res = await getAnimeEpisodesPage(malId, page);
    const items = res.data ?? [];

    for (const raw of items) {
      const ep = mapEpisode(raw);
      await prisma.episode.upsert({
        where: { animeId_malEpisodeId: { animeId, malEpisodeId: ep.malEpisodeId } },
        create: { animeId, ...ep },
        update: ep,
      });
      written++;
    }

    if (!res.pagination?.has_next_page || items.length === 0) break;
    page++;
  }

  cache.delPattern(`anime:episodes:${malId}`);
  return written;
}
