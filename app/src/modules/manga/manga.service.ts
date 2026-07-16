/**
 * Manga catalog reads — browse / detail / fuzzy search / sitemap. Mirrors
 * modules/anime/anime.service.ts: listing endpoints are Postgres-only; the
 * single-manga path read-throughs to Jikan on a miss; search tops up from
 * Jikan when the local catalog is sparse.
 */
import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import { cache } from "../../lib/cache";
import { normalizeForSearch } from "../../lib/searchText";
import { getMangaFull, searchMangaPage } from "../../lib/catalog/jikanClient";
import { logSyncJob } from "../anime/animeSync.service";
import {
  enqueueMangaFullSync,
  upsertMangaFromJikan,
  upsertMangaStubFromSearchResult,
} from "./mangaSync.service";
import type { BrowseMangaQuery } from "./manga.schema";

// ─── Pagination helpers (same shapes as anime) ───────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function buildMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── Manga include shape ──────────────────────────────────────────────────────

const mangaInclude = {
  genres: { include: { genre: true } },
} as const;

type MangaWithRelations = {
  id: string;
  malId: number;
  slug: string | null;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  synopsis: string | null;
  type: string | null;
  chapters: number | null;
  volumes: number | null;
  status: string | null;
  publishing: boolean;
  publishedFrom: Date | null;
  publishedTo: Date | null;
  demographic: string | null;
  authors: string[];
  serializations: string[];
  score: number | null;
  membersCount: number | null;
  imageUrl: string | null;
  updatedAt: Date;
  genres: Array<{ genre: { id: string; name: string } }>;
};

function flattenManga(manga: MangaWithRelations) {
  const { genres, ...rest } = manga;
  return {
    ...rest,
    genres: genres.map((mg) => mg.genre.name),
  };
}

export const flattenMangaPublic = flattenManga;

// ─── browse ───────────────────────────────────────────────────────────────────
// Postgres ONLY — never calls Jikan at request time (same contract as anime
// browse). Filters: q, status, type, demographic, genre (incl. Boys Love).

export async function browse(query: BrowseMangaQuery) {
  const cacheKey = `manga:browse:${JSON.stringify(query)}`;
  const cached = cache.get<{ data: unknown[]; meta: unknown }>(cacheKey);
  if (cached) return cached;

  const { q, type, status, demographic, genre, page, limit } = query;
  const { skip, take } = paginate(page, limit);

  const where = {
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { titleEnglish: { contains: q, mode: "insensitive" as const } },
            { synopsis: { contains: q, mode: "insensitive" as const } },
            { genres: { some: { genre: { name: { contains: q, mode: "insensitive" as const } } } } },
          ],
        }
      : {}),
    ...(type ? { type } : {}),
    ...(status ? { status: { equals: status, mode: "insensitive" as const } } : {}),
    ...(demographic ? { demographic: { equals: demographic, mode: "insensitive" as const } } : {}),
    ...(genre ? { genres: { some: { genre: { name: { contains: genre, mode: "insensitive" as const } } } } } : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.manga.findMany({
      where,
      skip,
      take,
      include: mangaInclude,
      orderBy: { score: { sort: "desc", nulls: "last" } },
    }),
    prisma.manga.count({ where }),
  ]);

  const result = {
    data: (data as MangaWithRelations[]).map((m) => flattenManga(m)),
    meta: buildMeta(total, page, limit),
  };
  cache.set(cacheKey, result, 5 * 60_000);
  return result;
}

// ─── getSitemapEntries (SEO sitemap feed) ────────────────────────────────────
// Same quality gate philosophy as the anime sitemap (no thin/stub pages).
// Manga readership skews lower than anime, so the members floor is lower.

const SITEMAP_MEMBERS_FLOOR = 200;

export async function getSitemapEntries(): Promise<Array<{ malId: number; updatedAt: Date }>> {
  const cacheKey = "manga:sitemap";
  const cached = cache.get<Array<{ malId: number; updatedAt: Date }>>(cacheKey);
  if (cached) return cached;

  const rows = await prisma.manga.findMany({
    where: {
      isStub: false,
      score: { not: null },
      membersCount: { gte: SITEMAP_MEMBERS_FLOOR },
      synopsis: { not: null },
      NOT: { synopsis: "" },
    },
    select: { malId: true, updatedAt: true },
    orderBy: { membersCount: "desc" },
  });

  cache.set(cacheKey, rows, 6 * 60 * 60_000); // 6h
  return rows;
}

// ─── getById / getBySlug — canonical read-through path ───────────────────────

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type MangaRow = MangaWithRelations & {
  isStub: boolean;
  lastSyncedAt: Date | null;
};

async function serveLocalManga(
  where: { malId: number } | { slug: string },
  userId?: string,
  cacheKey?: string,
) {
  const manga = (await prisma.manga.findUnique({
    where: where as { malId: number },
    include: mangaInclude,
  })) as MangaRow | null;
  if (!manga) return null;

  const needsSync =
    manga.isStub ||
    !manga.lastSyncedAt ||
    Date.now() - manga.lastSyncedAt.getTime() > STALE_AFTER_MS;
  if (needsSync) {
    void enqueueMangaFullSync(manga.malId).catch(() => {});
  }

  const flat = flattenManga(manga);

  let readlistEntry = null;
  if (userId) {
    readlistEntry = await prisma.mangaEntry.findUnique({
      where: { userId_mangaId: { userId, mangaId: manga.id } },
    });
  }

  const result = { manga: flat, readlistEntry };
  if (!userId && cacheKey) cache.set(cacheKey, result, 60 * 60_000); // 1h
  return result;
}

export async function getById(malId: number, userId?: string) {
  const cacheKey = `manga:${malId}`;
  if (!userId) {
    const cached = cache.get<{ manga: ReturnType<typeof flattenManga>; readlistEntry: null }>(cacheKey);
    if (cached) return cached;
  }

  const local = await serveLocalManga({ malId }, userId, cacheKey);
  if (local) return local;

  // Read-through fallback: unknown malId → fetch once, persist, serve.
  const started = Date.now();
  try {
    const full = await getMangaFull(malId, { timeoutMs: 8_000 });
    await upsertMangaFromJikan(full);
    void logSyncJob({ jobType: "on_demand_manga", malId, status: "success", durationMs: Date.now() - started });
  } catch (err) {
    void logSyncJob({
      jobType: "on_demand_manga",
      malId,
      status: "failed",
      error: (err as Error).message,
      durationMs: Date.now() - started,
    });
    throw notFound("Manga not found");
  }

  const persisted = await serveLocalManga({ malId }, userId, cacheKey);
  if (!persisted) throw notFound("Manga not found");
  return persisted;
}

export async function getBySlug(slug: string, userId?: string) {
  const cacheKey = `manga:slug:${slug}`;
  if (!userId) {
    const cached = cache.get<{ manga: ReturnType<typeof flattenManga>; readlistEntry: null }>(cacheKey);
    if (cached) return cached;
  }

  // Slugs are minted locally — no upstream fallback on this path.
  const local = await serveLocalManga({ slug }, userId, cacheKey);
  if (!local) throw notFound("Manga not found");
  return local;
}

// ─── searchWithFallback ──────────────────────────────────────────────────────
// Identical ranking contract to anime search: exact > prefix > word-boundary >
// trigram similarity over the normalized multi-title haystack, tie-broken by
// similarity then score; graceful degrade to contains; Jikan top-up when the
// local catalog returns fewer than 5 hits.

export async function searchWithFallback(qRaw: string): Promise<MangaWithRelations[]> {
  const q = normalizeForSearch(qRaw);
  if (!q) return [];
  const cacheKey = `manga:search:${q}`;
  const cached = cache.get<MangaWithRelations[]>(cacheKey);
  if (cached) return cached;

  const like = `%${q}%`;
  const prefix = `${q}%`;
  let local: MangaWithRelations[] = [];
  try {
    // <% (word_similarity) catches single-word typos ("bersrk") that whole-string
    // similarity misses against long multi-title haystacks; SET LOCAL keeps the
    // permissive threshold scoped to this transaction's connection only.
    const [, idRows] = await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = 0.45`),
      prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "Manga"
          WHERE "searchText" IS NOT NULL AND ("searchText" LIKE $1 OR $2 <% "searchText")
          ORDER BY
            (CASE
               WHEN "searchText" = $2 THEN 4
               WHEN "searchText" LIKE $3 THEN 3
               WHEN "searchText" LIKE ('% ' || $2 || '%') THEN 2
               ELSE 1
             END) DESC,
            GREATEST(similarity("searchText", $2), word_similarity($2, "searchText")) DESC,
            COALESCE("score", 0) DESC
          LIMIT 25`,
        like, q, prefix,
      ),
    ]);
    const ids = idRows.map((r) => r.id);
    if (ids.length) {
      const found = await prisma.manga.findMany({
        where: { id: { in: ids } },
        include: mangaInclude,
      });
      const order = new Map(ids.map((id, i) => [id, i]));
      local = (found as MangaWithRelations[]).sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
    }
  } catch (err) {
    // pg_trgm / table not ready yet (fresh deploy) → degrade to contains.
    console.error("[manga-search] trigram query failed, falling back to contains:", (err as Error).message);
    local = (await prisma.manga.findMany({
      where: {
        OR: [
          { title: { contains: qRaw, mode: "insensitive" } },
          { titleEnglish: { contains: qRaw, mode: "insensitive" } },
        ],
      },
      include: mangaInclude,
      take: 20,
      orderBy: { score: { sort: "desc", nulls: "last" } },
    })) as MangaWithRelations[];
  }

  if (local.length >= 5) {
    cache.set(cacheKey, local, 10 * 60_000);
    return local;
  }

  // Upstream top-up: stub-upsert Jikan results, full detail arrives via queue.
  // Jikan's /manga?q= endpoint 504s for long stretches while /manga/{id}/full
  // stays up, so on failure we fall back to AniList search (returns idMal →
  // stubs stay MAL-keyed and the sync queue upgrades them from Jikan later).
  const upstreamMalIds: number[] = [];
  try {
    const upstream = await searchMangaPage(qRaw, { limit: 10 });
    for (const m of upstream.data ?? []) {
      await upsertMangaStubFromSearchResult(m);
      upstreamMalIds.push(m.mal_id);
      void enqueueMangaFullSync(m.mal_id).catch(() => {});
    }
  } catch {
    try {
      const { searchMangaStubs } = await import("../../lib/anilist");
      const { buildSearchText } = await import("../../lib/searchText");
      const stubs = await searchMangaStubs(qRaw);
      for (const s of stubs) {
        const existing = await prisma.manga.findUnique({
          where: { malId: s.malId },
          select: { id: true, isStub: true, lastSyncedAt: true },
        });
        // Full rows are stronger data — never overwrite them from AniList.
        if (!existing || (existing.isStub && !existing.lastSyncedAt)) {
          await prisma.manga.upsert({
            where: { malId: s.malId },
            create: {
              malId: s.malId,
              title: s.title,
              titleEnglish: s.titleEnglish,
              titleSynonyms: s.synonyms,
              searchText: buildSearchText({
                title: s.title,
                titleEnglish: s.titleEnglish,
                titleSynonyms: s.synonyms,
              }),
              imageUrl: s.coverUrl,
              chapters: s.chapters,
              volumes: s.volumes,
              type: s.format === "MANGA" ? "Manga" : s.format === "NOVEL" ? "Light Novel" : s.format === "ONE_SHOT" ? "One-shot" : s.format,
              score: s.meanScore != null ? s.meanScore / 10 : null,
              isStub: true,
            },
            update: {},
          });
        }
        upstreamMalIds.push(s.malId);
        void enqueueMangaFullSync(s.malId).catch(() => {});
      }
    } catch {
      // Both upstreams down — serve what we have.
      cache.set(cacheKey, local, 5 * 60_000);
      return local;
    }
  }

  const seen = new Set(local.map((m) => m.malId));
  const refreshed = await prisma.manga.findMany({
    where: { malId: { in: upstreamMalIds.filter((id) => !seen.has(id)) } },
    include: mangaInclude,
    take: 20,
  });
  const merged = [...local, ...(refreshed as MangaWithRelations[])].slice(0, 20);
  cache.set(cacheKey, merged, 10 * 60_000);
  return merged;
}

// ─── requestMissingTitle ─────────────────────────────────────────────────────

export async function requestMissingTitle(rawQuery: string): Promise<{ ok: true }> {
  const query = normalizeForSearch(rawQuery);
  if (!query || query.length < 2) return { ok: true };
  await prisma.animeTitleRequest
    .upsert({
      where: { query },
      create: { query, rawQuery: rawQuery.slice(0, 200), kind: "manga" },
      update: { requestCount: { increment: 1 }, lastRequestedAt: new Date() },
    })
    .catch(() => {});
  void (async () => {
    try {
      const up = await searchMangaPage(rawQuery, { limit: 5 });
      for (const m of up.data ?? []) {
        await upsertMangaStubFromSearchResult(m);
        void enqueueMangaFullSync(m.mal_id).catch(() => {});
      }
    } catch { /* best-effort */ }
  })();
  return { ok: true };
}

// ─── listGenres / listDemographics ───────────────────────────────────────────

/** Distinct catalog genres actually used by manga, ordered by usage. */
export async function listGenres(limit = 50) {
  const rows = await prisma.genre.findMany({
    where: { mangas: { some: {} } },
    take: limit,
    include: { _count: { select: { mangas: true } } },
    orderBy: { mangas: { _count: "desc" } },
  });
  return rows.map((g: { name: string; _count: { mangas: number } }) => ({
    name: g.name,
    count: g._count.mangas,
  }));
}

export async function getMangaUserStats(malId: number) {
  const manga = await prisma.manga.findUnique({ where: { malId }, select: { id: true } });
  if (!manga) return { reading: 0, completed: 0, planToRead: 0, onHold: 0, dropped: 0, total: 0 };

  const [reading, completed, planToRead, onHold, dropped] = await Promise.all([
    prisma.mangaEntry.count({ where: { mangaId: manga.id, status: "READING" } }),
    prisma.mangaEntry.count({ where: { mangaId: manga.id, status: "COMPLETED" } }),
    prisma.mangaEntry.count({ where: { mangaId: manga.id, status: "PLAN_TO_READ" } }),
    prisma.mangaEntry.count({ where: { mangaId: manga.id, status: "ON_HOLD" } }),
    prisma.mangaEntry.count({ where: { mangaId: manga.id, status: "DROPPED" } }),
  ]);

  const total = reading + completed + planToRead + onHold + dropped;
  return { reading, completed, planToRead, onHold, dropped, total };
}
