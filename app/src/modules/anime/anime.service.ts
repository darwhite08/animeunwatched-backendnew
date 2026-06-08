import { prisma } from "../../config/prisma";
import type { CatalogAnime } from "../../lib/catalog/types";
import { notFound } from "../../lib/errors";
import { cache } from "../../lib/cache";
import { jaccard, overlapCoeff, linearProximity, capPerGroup, logNormalize } from "../../lib/ranking";
import { getAnimeFull, getRaw, searchAnimePage } from "../../lib/catalog/jikanClient";
import { logSyncJob, upsertAnimeFromJikan, upsertStubFromSearchResult } from "./animeSync.service";
import { enqueueAnimeFullSync, enqueueEpisodeSync } from "./syncQueue.service";
import type { BrowseQuery } from "./anime.schema";

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function buildMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── Anime include shape ──────────────────────────────────────────────────────

const animeInclude = {
  genres: { include: { genre: true } },
  studios: { include: { studio: true } },
} as const;

type AnimeWithRelations = {
  id: string;
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  synopsis: string | null;
  type: string | null;
  episodes: number | null;
  status: string | null;
  airedFrom: Date | null;
  airedTo: Date | null;
  season: string | null;
  year: number | null;
  rating: string | null;
  score: number | null;
  imageUrl: string | null;
  trailerUrl: string | null;
  source: string | null;
  updatedAt: Date;
  genres: Array<{ genre: { id: string; name: string } }>;
  studios: Array<{ studio: { id: string; name: string } }>;
};

function flattenAnime(anime: AnimeWithRelations) {
  const { genres, studios, ...rest } = anime;
  return {
    ...rest,
    genres: genres.map((ag) => ag.genre.name),
    studios: studios.map((as_) => as_.studio.name),
  };
}

// Public export for use in the search controller
export const flattenAnimePublic = flattenAnime;

// ─── Upsert genres/studios ────────────────────────────────────────────────────

export async function upsertFromCatalog(data: CatalogAnime) {
  const genreRecords = await Promise.all(
    data.genres.map((name) =>
      prisma.genre.upsert({ where: { name }, create: { name }, update: {} }),
    ),
  );

  const studioRecords = await Promise.all(
    data.studios.map((name) =>
      prisma.studio.upsert({ where: { name }, create: { name }, update: {} }),
    ),
  );

  const anime = await prisma.anime.upsert({
    where: { malId: data.malId },
    create: {
      malId: data.malId,
      title: data.title,
      titleEnglish: data.titleEnglish,
      titleJapanese: data.titleJapanese,
      synopsis: data.synopsis,
      type: data.type,
      episodes: data.episodes,
      status: data.status,
      airedFrom: data.airedFrom,
      airedTo: data.airedTo,
      season: data.season,
      year: data.year,
      rating: data.rating,
      score: data.score,
      imageUrl: data.imageUrl,
      trailerUrl: data.trailerUrl,
      source: data.source,
    },
    update: {
      title: data.title,
      titleEnglish: data.titleEnglish,
      titleJapanese: data.titleJapanese,
      synopsis: data.synopsis,
      type: data.type,
      episodes: data.episodes,
      status: data.status,
      airedFrom: data.airedFrom,
      airedTo: data.airedTo,
      season: data.season,
      year: data.year,
      rating: data.rating,
      score: data.score,
      imageUrl: data.imageUrl,
      trailerUrl: data.trailerUrl,
      source: data.source,
    },
    include: animeInclude,
  });

  // Reconcile genres and studios atomically to prevent concurrent-update race conditions
  await prisma.$transaction([
    prisma.animeGenre.deleteMany({ where: { animeId: anime.id } }),
    prisma.animeGenre.createMany({
      data: genreRecords.map((g: { id: string }) => ({ animeId: anime.id, genreId: g.id })),
      skipDuplicates: true,
    }),
    prisma.animeStudio.deleteMany({ where: { animeId: anime.id } }),
    prisma.animeStudio.createMany({
      data: studioRecords.map((s: { id: string }) => ({ animeId: anime.id, studioId: s.id })),
      skipDuplicates: true,
    }),
  ]);

  // Invalidate per-anime cache entry so next read gets fresh data
  cache.del(`anime:${data.malId}`);

  // Fetch fresh data (with updated genres/studios) for the return value
  const fresh = await prisma.anime.findUnique({ where: { id: anime.id }, include: animeInclude });
  return flattenAnime((fresh ?? anime) as AnimeWithRelations);
}

// ─── browse ───────────────────────────────────────────────────────────────────
// Postgres ONLY — the listing/grid is served entirely from our own catalog.
// Never calls Jikan at request time (spec §5). Jikan stays the background
// sync feed; on-demand fetches happen only on the single-anime getById path.

export async function browse(query: BrowseQuery) {
  const cacheKey = `anime:browse:${JSON.stringify(query)}`;
  const cached = cache.get<{ data: unknown[]; meta: unknown }>(cacheKey);
  if (cached) return cached;

  const { q, year, season, type, status, studio, start_date, end_date, page, limit, genre } = query as typeof query & { genre?: string };
  const hasFilters = !!(q || year || season || type || status || studio || start_date || end_date || genre);

  // ── No filters: Postgres ONLY (spec §5: "Listing endpoints query Postgres
  // only — never Jikan at request time"). The catalog is fully seeded, so the
  // DB is the source of truth; a partial last page just returns fewer rows.
  if (!hasFilters) {
    const { skip, take } = paginate(page, limit);
    const [localData, localTotal] = await prisma.$transaction([
      prisma.anime.findMany({
        skip, take, include: animeInclude,
        orderBy: { score: { sort: "desc", nulls: "last" } },
      }),
      prisma.anime.count(),
    ]);

    const result = {
      data: (localData as AnimeWithRelations[]).map((a) => flattenAnime(a)),
      meta: buildMeta(localTotal, page, limit),
    };
    cache.set(cacheKey, result, 15 * 60_000); // 15 min — local data is stable
    return result;
  }

  // ── Filters applied OR Jikan failed: use local DB ──
  const { skip, take } = paginate(page, limit);
  const where = {
    ...(q ? { OR: [
      { title:        { contains: q, mode: "insensitive" as const } },
      { titleEnglish: { contains: q, mode: "insensitive" as const } },
      { synopsis:     { contains: q, mode: "insensitive" as const } },
      { genres: { some: { genre: { name: { contains: q, mode: "insensitive" as const } } } } },
    ]} : {}),
    ...(year !== undefined ? { year } : {}),
    ...(season ? { season } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(studio ? { studios: { some: { studio: { name: { contains: studio, mode: "insensitive" as const } } } } } : {}),
    ...(genre  ? { genres:  { some: { genre:  { name: { contains: genre,  mode: "insensitive" as const } } } } } : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.anime.findMany({ where, skip, take, include: animeInclude, orderBy: { score: { sort: "desc", nulls: "last" } } }),
    prisma.anime.count({ where }),
  ]);

  // Postgres only — a filter with no local matches returns an empty page
  // rather than calling Jikan at request time (spec §5).
  const result = {
    data: (data as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
    meta: buildMeta(total, page, limit),
  };
  cache.set(cacheKey, result, 5 * 60_000);
  return result;
}

// ─── getById / getBySlug — canonical read-through path ───────────────────────
//
//   1. cache hit                            → serve
//   2. Postgres hit, fully synced & fresh   → serve
//   3. Postgres hit but stub / never-synced / stale
//                                           → serve immediately + ENQUEUE full
//                                             sync (never blocks the request)
//   4. Postgres miss (malId path only)      → ONE blocking Jikan fetch through
//                                             the rate-limited client, persist,
//                                             serve; clean 404 on failure.
//   The DB grows organically from misses; listing endpoints never do step 4.

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type AnimeRow = AnimeWithRelations & {
  slug: string | null;
  isStub: boolean;
  lastSyncedAt: Date | null;
};

/** Steps 2–3: serve the local row and queue background work if it's not a
 *  fully-synced fresh row. Returns null when there is no local row at all. */
async function serveLocalAnime(
  where: { malId: number } | { slug: string },
  userId?: string,
  cacheKey?: string,
) {
  const anime = (await prisma.anime.findUnique({ where: where as { malId: number }, include: animeInclude })) as
    | AnimeRow
    | null;
  if (!anime) return null;

  const needsSync =
    anime.isStub ||
    !anime.lastSyncedAt ||
    Date.now() - anime.lastSyncedAt.getTime() > STALE_AFTER_MS;
  if (needsSync) {
    // Serve what we have NOW; freshness arrives via the worker. (Dedupe +
    // the 7-day freshness check inside enqueueAnimeFullSync keep this cheap.)
    void enqueueAnimeFullSync(anime.malId).catch(() => {});
  }

  const flat = flattenAnime(anime);

  let listEntry = null;
  if (userId) {
    listEntry = await prisma.listEntry.findUnique({
      where: { userId_animeId: { userId, animeId: anime.id } },
    });
  }

  const result = { anime: flat, listEntry };
  if (!userId && cacheKey) cache.set(cacheKey, result, 60 * 60_000); // 1h
  return result;
}

export async function getById(malId: number, userId?: string) {
  // Only cache for unauthenticated requests (no userId) since listEntry is user-specific
  const cacheKey = `anime:${malId}`;
  if (!userId) {
    const cached = cache.get<{ anime: ReturnType<typeof flattenAnime>; listEntry: null }>(cacheKey);
    if (cached) return cached;
  }

  const local = await serveLocalAnime({ malId }, userId, cacheKey);
  if (local) return local;

  // Read-through fallback: unknown malId → fetch once, persist, serve.
  const started = Date.now();
  try {
    const full = await getAnimeFull(malId, { timeoutMs: 8_000 });
    await upsertAnimeFromJikan(full);
    void logSyncJob({ jobType: "on_demand", malId, status: "success", durationMs: Date.now() - started });
  } catch (err) {
    void logSyncJob({
      jobType: "on_demand",
      malId,
      status: "failed",
      error: (err as Error).message,
      durationMs: Date.now() - started,
    });
    throw notFound("Anime not found");
  }

  const persisted = await serveLocalAnime({ malId }, userId, cacheKey);
  if (!persisted) throw notFound("Anime not found");
  return persisted;
}

export async function getBySlug(slug: string, userId?: string) {
  const cacheKey = `anime:slug:${slug}`;
  if (!userId) {
    const cached = cache.get<{ anime: ReturnType<typeof flattenAnime>; listEntry: null }>(cacheKey);
    if (cached) return cached;
  }

  // Slugs are minted locally — a miss can't be resolved upstream, so no
  // Jikan fallback on this path.
  const local = await serveLocalAnime({ slug }, userId, cacheKey);
  if (!local) throw notFound("Anime not found");
  return local;
}

// ─── getSchedule (weekly airing, via the catalog/Jikan client) ───────────────

export async function getSchedule(
  day: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday",
) {
  const { getSchedulesPage } = await import("../../lib/catalog/jikanClient");
  const res = await getSchedulesPage(day);
  const seen = new Set<number>();
  const data = (res.data ?? [])
    .map((a: any) => ({
      malId: a.mal_id,
      title: a.title_english || a.title,
      imageUrl: a.images?.jpg?.image_url ?? a.images?.jpg?.large_image_url ?? null,
      broadcastTime: a.broadcast?.string && a.broadcast.string !== "Unknown" ? a.broadcast.string : (a.broadcast?.time ?? null),
      episodes: a.episodes ?? null,
      score: a.score ?? null,
      type: a.type ?? null,
    }))
    .filter((a: { malId: number }) => a.malId && !seen.has(a.malId) && seen.add(a.malId));
  return { data };
}

// ─── getSeasonal ─────────────────────────────────────────────────────────────

export async function getSeasonal(
  year: number,
  season: "winter" | "spring" | "summer" | "fall",
  page = 1,
  limit = 20,
) {
  const { skip, take } = paginate(page, limit);

  const existing = await prisma.anime.count({ where: { year, season } });

  if (existing === 0) {
    // Cold season: one synchronous page so the response isn't empty, then the
    // worker fills in full detail.
    try {
      const { getSeasonPage } = await import("../../lib/catalog/jikanClient");
      const res = await getSeasonPage(year, season, 1);
      for (const item of res.data ?? []) {
        await upsertStubFromSearchResult(item);
        void enqueueAnimeFullSync(item.mal_id).catch(() => {});
      }
    } catch {
      // Jikan unavailable → serve whatever the DB has.
    }
  }

  const where = { year, season };
  const [data, total] = await prisma.$transaction([
    prisma.anime.findMany({ where, skip, take, include: animeInclude, orderBy: { score: { sort: "desc", nulls: "last" } } }),
    prisma.anime.count({ where }),
  ]);

  return {
    data: (data as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
    meta: buildMeta(total, page, limit),
  };
}

// ─── searchWithFallback ──────────────────────────────────────────────────────

export async function searchWithFallback(q: string): Promise<AnimeWithRelations[]> {
  const cacheKey = `search:${q}`
  const cached = cache.get<AnimeWithRelations[]>(cacheKey)
  if (cached) return cached

  // Local DB first — search title, synopsis AND genres
  const local = await prisma.anime.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { titleEnglish: { contains: q, mode: "insensitive" } },
        { synopsis: { contains: q, mode: "insensitive" } },
        { genres: { some: { genre: { name: { contains: q, mode: "insensitive" } } } } },
        { studios: { some: { studio: { name: { contains: q, mode: "insensitive" } } } } },
      ]
    },
    include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
    take: 20,
    orderBy: { score: { sort: "desc", nulls: "last" } },
  })

  // Local DB satisfies the query → done. Threshold of 5 (spec §5): fewer hits
  // than that and we top up from Jikan so sparse-DB searches still work.
  if (local.length >= 5) {
    cache.set(cacheKey, local, 10 * 60_000) // 10 min
    return local
  }

  // Upstream top-up: stub-upsert Jikan results (full detail arrives via the
  // worker queue), then merge with the local hits.
  try {
    const upstream = await searchAnimePage(q, { limit: 10 })
    for (const a of upstream.data ?? []) {
      await upsertStubFromSearchResult(a)
      void enqueueAnimeFullSync(a.mal_id).catch(() => {})
    }
    const seen = new Set(local.map(a => a.malId))
    const refreshed = await prisma.anime.findMany({
      where: { malId: { in: (upstream.data ?? []).map(a => a.mal_id).filter(id => !seen.has(id)) } },
      include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
      take: 20,
    })
    const merged = [...local, ...refreshed].slice(0, 20)
    cache.set(cacheKey, merged, 10 * 60_000)
    return merged
  } catch {
    cache.set(cacheKey, local, 5 * 60_000)
    return local
  }
}

// ─── getTrending ─────────────────────────────────────────────────────────────

export async function getTrending(limit = 20) {
  const cacheKey = `anime:trending`
  const cached = cache.get<unknown[]>(cacheKey)
  if (cached) return cached

  // "Trending Now" — served from the precomputed trendingScore (compute-trending
  // worker, docs/trending-algorithm.md). Single indexed ORDER BY, no request-time
  // compute. Falls back to score when no title has been scored yet (cold platform).
  const trending = await prisma.anime.findMany({
    where: { trendingScore: { gt: 0 } },
    orderBy: { trendingScore: "desc" },
    take: limit,
    include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
  })

  const result = trending.length > 0
    ? trending
    : await prisma.anime.findMany({
        where: { score: { not: null } },
        orderBy: [{ status: "asc" }, { score: { sort: "desc", nulls: "last" } }],
        take: limit,
        include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
      })

  cache.set(cacheKey, result, 15 * 60_000) // 15 min
  return result
}

// ─── getAnimeUserStats ────────────────────────────────────────────────────────

export async function getAnimeUserStats(malId: number) {
  const anime = await prisma.anime.findUnique({ where: { malId }, select: { id: true } });
  if (!anime) return { watching: 0, completed: 0, planToWatch: 0, total: 0 };

  const [watching, completed, planToWatch, onHold, dropped] = await Promise.all([
    prisma.listEntry.count({ where: { animeId: anime.id, status: "WATCHING" } }),
    prisma.listEntry.count({ where: { animeId: anime.id, status: "COMPLETED" } }),
    prisma.listEntry.count({ where: { animeId: anime.id, status: "PLAN_TO_WATCH" } }),
    prisma.listEntry.count({ where: { animeId: anime.id, status: "ON_HOLD" } }),
    prisma.listEntry.count({ where: { animeId: anime.id, status: "DROPPED" } }),
  ]);

  const total = watching + completed + planToWatch + onHold + dropped;
  return { watching, completed, planToWatch, onHold, dropped, total };
}

// ─── getForYou (personalised "what to watch next") ───────────────────────────
//
// Build a TASTE PROFILE from the viewer's list:
//   - genre affinities  — weighted by the viewer's per-entry score (or 6/10
//                         default for unrated entries; COMPLETED counts double
//                         since it's stronger signal than PLAN_TO_WATCH)
//   - studio affinities — bare count, capped
//   - preferred era     — average year of liked entries
//
// Score each candidate (anime NOT in the viewer's list) by:
//     0.55 × (sum over its genres of genre_affinity) / sqrt(genre count)
//   + 0.20 × (sum over its studios of studio_affinity)
//   + 0.15 × era_proximity to preferred year
//   + 0.10 × logNormalize(catalog_score)
//
// Then diversity-cap to 1 entry per studio so we surface a varied list,
// not the same studio's back-catalogue. Falls back to high-rated catalog
// browse when the viewer has no list yet.

export async function getForYou(userId: string, limit = 20) {
  const cacheKey = `anime:foryou:${userId}:${limit}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const entries = await prisma.listEntry.findMany({
    where: { userId },
    select: {
      animeId: true, status: true, score: true,
      anime: {
        select: {
          id: true, year: true,
          genres:  { select: { genreId: true  } },
          studios: { select: { studioId: true } },
        },
      },
    },
  })

  // Cold-start: brand-new user → return globally top-rated as a fallback.
  if (entries.length === 0) {
    const fallback = await prisma.anime.findMany({
      where: { score: { gte: 7.5 } },
      orderBy: { score: { sort: "desc", nulls: "last" } },
      take: limit,
      include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
    })
    cache.set(cacheKey, fallback, 30 * 60_000)
    return fallback
  }

  // ── Build taste profile ──
  const genreAffinity  = new Map<string, number>()
  const studioAffinity = new Map<string, number>()
  let yearSum = 0, yearCount = 0
  const watched = new Set<string>()

  for (const e of entries) {
    watched.add(e.animeId)
    const ratingWeight = (e.score ?? 6) / 10 // 0.1–1.0
    const statusBoost  = e.status === "COMPLETED" ? 2 : 1
    const w = ratingWeight * statusBoost

    for (const g of e.anime.genres) {
      genreAffinity.set(g.genreId, (genreAffinity.get(g.genreId) ?? 0) + w)
    }
    for (const s of e.anime.studios) {
      studioAffinity.set(s.studioId, (studioAffinity.get(s.studioId) ?? 0) + w * 0.5)
    }
    if (e.anime.year) { yearSum += e.anime.year * w; yearCount += w }
  }
  const preferredYear = yearCount > 0 ? yearSum / yearCount : null

  const topGenres = [...genreAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0])

  // ── Candidate pull: anime with at least one of the user's top genres,
  //    not already on their list. Capped at 300 then reranked in JS.
  const candidates = await prisma.anime.findMany({
    where: {
      id:    { notIn: [...watched] },
      genres: { some: { genreId: { in: topGenres } } },
      score:  { gte: 6.0 },  // basic quality floor — junk doesn't get personalised
    },
    take: 300,
    include: {
      genres: { include: { genre: true } },
      studios: { include: { studio: true } },
    },
  })

  // ── Score + sort ──
  const scored = candidates.map(c => {
    const cGenres  = c.genres.map(g => g.genreId)
    const cStudios = c.studios.map(s => s.studioId)
    const genreFit = cGenres.reduce((sum, g) => sum + (genreAffinity.get(g) ?? 0), 0)
                   / Math.max(1, Math.sqrt(cGenres.length))
    const studioFit = cStudios.reduce((sum, s) => sum + (studioAffinity.get(s) ?? 0), 0)
    const era = (preferredYear && c.year) ? linearProximity(preferredYear, c.year, 15) : 0
    const quality = logNormalize(Math.round((c.score ?? 0) * 10), 100)

    return {
      anime: c,
      score: 0.55 * genreFit
           + 0.20 * studioFit
           + 0.15 * era
           + 0.10 * quality,
    }
  })

  const sorted = scored.sort((a, b) => b.score - a.score)
  const capped = capPerGroup(
    sorted,
    s => s.anime.studios[0]?.studioId ?? "_no_studio",
    2,
    limit,
  )

  const out = capped.map(s => s.anime)
  cache.set(cacheKey, out, 15 * 60_000) // 15 min — taste evolves slowly
  return out
}

// ─── getSimilar ──────────────────────────────────────────────────────────────
//
// Algorithm: weighted multi-signal similarity, not just "any genre matches".
//
//   similarity =
//       0.50 × jaccard(genres)
//     + 0.20 × overlapCoeff(studios)        — studio match is a strong signal
//     + 0.15 × type_match (TV ↔ TV > TV ↔ Movie)
//     + 0.10 × era_proximity (within 10 years scaling linearly)
//     + 0.05 × quality_proximity (don't recommend a 4 from a 9)
//
// Then sort, cap at one entry per franchise-shaped group (same studio set
// AND same type) to avoid recommending 5 entries of the same show.
//
// When called with a userId, anime already in the viewer's list are
// removed so we don't recommend things they've already tracked.

export async function getSimilar(malId: number, limit = 12, userId?: string) {
  // Personalised exclusion can't share the anonymous cache.
  const cacheKey = userId ? `anime:similar:${malId}:u:${userId}` : `anime:similar:${malId}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const source = await prisma.anime.findFirst({
    where: { malId },
    include: { genres: true, studios: true },
  })
  if (!source) throw notFound("Anime not found")

  const sourceGenreIds  = source.genres.map((g: { genreId: string }) => g.genreId)
  const sourceStudioIds = source.studios.map((s: { studioId: string }) => s.studioId)
  if (sourceGenreIds.length === 0) {
    // Without genres we have no signal; fall back to top-score in same type.
    const fallback = await prisma.anime.findMany({
      where: { malId: { not: malId }, type: source.type, score: { not: null } },
      orderBy: { score: { sort: "desc", nulls: "last" } },
      take: limit,
      include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
    })
    cache.set(cacheKey, fallback, 60 * 60_000)
    return fallback
  }

  // Cast a wide net: any genre overlap. We then rerank in JS.
  // Excluded: source itself, items in the viewer's list (when authed).
  const watchedAnimeIds = userId
    ? new Set((await prisma.listEntry.findMany({
        where: { userId }, select: { animeId: true },
      })).map(e => e.animeId))
    : new Set<string>()

  const candidates = await prisma.anime.findMany({
    where: {
      malId: { not: malId },
      id:    { notIn: [...watchedAnimeIds] },
      genres: { some: { genreId: { in: sourceGenreIds } } },
    },
    take: 200,
    include: { genres: true, studios: true },
  })

  const sourceGenreSet  = new Set(sourceGenreIds)
  const sourceStudioSet = new Set(sourceStudioIds)
  const sourceYear      = source.year ?? null
  const sourceScore     = source.score ?? null

  const scored = candidates.map(c => {
    const cGenres  = new Set(c.genres.map(g => g.genreId))
    const cStudios = new Set(c.studios.map(s => s.studioId))

    const genreScore  = jaccard(sourceGenreSet, cGenres)
    const studioScore = overlapCoeff(sourceStudioSet, cStudios)
    const typeScore   = c.type && source.type && c.type === source.type ? 1 : 0
    const yearScore   = (sourceYear && c.year)
      ? linearProximity(sourceYear, c.year, 10)
      : 0
    const qualityScore = (sourceScore != null && c.score != null)
      ? linearProximity(sourceScore, c.score, 5)
      : 0

    return {
      anime: c,
      score: 0.50 * genreScore
           + 0.20 * studioScore
           + 0.15 * typeScore
           + 0.10 * yearScore
           + 0.05 * qualityScore,
    }
  })

  // Sort then diversity cap: at most 2 per primary-studio so a single
  // production house can't dominate the recommendations.
  const sorted = scored.sort((a, b) => b.score - a.score)
  const capped = capPerGroup(
    sorted,
    s => s.anime.studios[0]?.studioId ?? "_no_studio",
    2,
    limit,
  )

  const out = capped.map(s => s.anime)
  cache.set(cacheKey, out, 60 * 60_000) // 1 hour
  return out
}

// ─── getCharacters ───────────────────────────────────────────────────────────
// Characters/staff aren't persisted locally (out of scope for the data layer)
// — passthrough via the rate-limited client so they share the global limiter.

export async function getCharacters(malId: number) {
  const key = `anime:characters:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  let data: unknown
  try {
    data = await getRaw(`/anime/${malId}/characters`)
  } catch {
    return { data: [] }
  }
  cache.set(key, data, 60 * 60_000) // 1 hour
  return data
}

// ─── getStaff ────────────────────────────────────────────────────────────────

export async function getStaff(malId: number) {
  const key = `anime:staff:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  let data: unknown
  try {
    data = await getRaw(`/anime/${malId}/staff`)
  } catch {
    return { data: [] }
  }
  cache.set(key, data, 60 * 60_000)
  return data
}

// ─── getEpisodes ──────────────────────────────────────────────────────────────
// Postgres-first (Episode table, synced by the worker). Falls back to a
// rate-limited Jikan passthrough only while the local list is still empty,
// enqueueing a sync so the next request is served locally. The response keeps
// Jikan's wire shape so the frontend needs no changes.

const EPISODES_PER_PAGE = 100 // matches Jikan's page size

export async function getEpisodes(malId: number, page = 1) {
  const key = `anime:episodes:${malId}:${page}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached

  const anime = await prisma.anime.findUnique({
    where: { malId },
    select: { id: true, episodes: true },
  })

  if (anime) {
    const [rows, total] = await prisma.$transaction([
      prisma.episode.findMany({
        where: { animeId: anime.id },
        orderBy: { malEpisodeId: "asc" },
        skip: (page - 1) * EPISODES_PER_PAGE,
        take: EPISODES_PER_PAGE,
      }),
      prisma.episode.count({ where: { animeId: anime.id } }),
    ])

    if (total > 0) {
      const lastPage = Math.max(1, Math.ceil(total / EPISODES_PER_PAGE))
      const data = {
        data: rows.map(e => ({
          mal_id: e.malEpisodeId,
          title: e.title,
          title_japanese: e.titleJapanese,
          title_romanji: e.titleRomaji,
          aired: e.aired?.toISOString() ?? null,
          score: e.score,
          filler: e.filler,
          recap: e.recap,
        })),
        pagination: { last_visible_page: lastPage, has_next_page: page < lastPage },
      }
      cache.set(key, data, 30 * 60_000) // 30 min
      return data
    }

    // Local list empty but the show has episodes → queue a sync for next time.
    if ((anime.episodes ?? 0) > 0) void enqueueEpisodeSync(malId).catch(() => {})
  }

  // Fallback while unsynced: rate-limited passthrough (previous behaviour).
  let data: unknown
  try {
    data = await getRaw(`/anime/${malId}/episodes?page=${page}`)
  } catch {
    return { data: [], pagination: { last_visible_page: 1, has_next_page: false } }
  }
  cache.set(key, data, 30 * 60_000)
  return data
}

// ─── getFranchise ────────────────────────────────────────────────────────────
// Relations are persisted (AnimeRelation) but the frontend consumes Jikan's
// /relations wire shape incl. manga entries — keep the passthrough for now.

export async function getFranchise(malId: number) {
  const key = `anime:franchise:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  let data: unknown
  try {
    data = await getRaw(`/anime/${malId}/relations`)
  } catch {
    return { data: [] }
  }
  cache.set(key, data, 60 * 60_000)
  return data
}

// ─── search ──────────────────────────────────────────────────────────────────

/** Distinct catalog genres, ordered by how many anime use them. */
export async function listGenres(limit = 50) {
  const rows = await prisma.genre.findMany({
    take: limit,
    include: { _count: { select: { animes: true } } },
    orderBy: { animes: { _count: "desc" } },
  })
  return rows.map((g: { name: string; _count: { animes: number } }) => ({
    name:  g.name,
    count: g._count.animes,
  }))
}

/** Distinct catalog studios, ordered by anime count. */
export async function listStudios(limit = 50) {
  const rows = await prisma.studio.findMany({
    take: limit,
    include: { _count: { select: { animes: true } } },
    orderBy: { animes: { _count: "desc" } },
  })
  return rows.map((s: { name: string; _count: { animes: number } }) => ({
    name:  s.name,
    count: s._count.animes,
  }))
}

export async function search(q: string, page = 1, limit = 20) {
  const { skip, take } = paginate(page, limit);
  const where = { title: { contains: q, mode: "insensitive" as const } };

  const [localData, total] = await prisma.$transaction([
    prisma.anime.findMany({ where, skip, take, include: animeInclude }),
    prisma.anime.count({ where }),
  ]);

  if (localData.length === 0) {
    const upstream = await searchAnimePage(q, { limit: 10 }).catch(() => ({ data: [] }));
    await Promise.all(
      (upstream.data ?? []).map(async (item) => {
        await upsertStubFromSearchResult(item);
        void enqueueAnimeFullSync(item.mal_id).catch(() => {});
      }),
    );
    const [fresh, freshTotal] = await prisma.$transaction([
      prisma.anime.findMany({ where, skip, take, include: animeInclude }),
      prisma.anime.count({ where }),
    ]);
    return {
      data: (fresh as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
      meta: buildMeta(freshTotal, page, limit),
    };
  }

  return {
    data: (localData as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
    meta: buildMeta(total, page, limit),
  };
}
