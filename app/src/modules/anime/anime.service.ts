import { prisma } from "../../config/prisma";
import { catalog } from "../../lib/catalog";
import type { CatalogAnime } from "../../lib/catalog/types";
import { notFound } from "../../lib/errors";
import { cache } from "../../lib/cache";
import { jaccard, overlapCoeff, linearProximity, capPerGroup, logNormalize } from "../../lib/ranking";
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
// When no filters are applied → fetch directly from Jikan (all 25000+ anime, paginated)
// and cache results into our DB for future use.
// When filters are applied → query our local DB which has synced data.

type JikanAnimeRaw = Record<string, unknown>;

function mapJikanRaw(a: JikanAnimeRaw) {
  const aired = (a.aired as Record<string, unknown>)?.from as string | null;
  return {
    malId:         a.mal_id as number,
    title:         a.title as string,
    titleEnglish:  (a.title_english as string) || null,
    titleJapanese: (a.title_japanese as string) || null,
    synopsis:      (a.synopsis as string) || null,
    type:          (a.type as string) || null,
    episodes:      (a.episodes as number) || null,
    status:        (a.status as string) || null,
    airedFrom:     aired ? new Date(aired) : null,
    airedTo:       null,
    season:        (a.season as string) || null,
    year:          (a.year as number) || null,
    rating:        (a.rating as string) || null,
    score:         (a.score as number) || null,
    imageUrl:      ((a.images as Record<string, Record<string, string>>)?.jpg?.large_image_url)
                   || ((a.images as Record<string, Record<string, string>>)?.jpg?.image_url) || null,
    trailerUrl:    ((a.trailer as Record<string, string>)?.url) || null,
    source:        (a.source as string) || null,
    genres:        ((a.genres as Array<Record<string, string>>) ?? []).map(g => g.name),
    studios:       ((a.studios as Array<Record<string, string>>) ?? []).map(s => s.name),
  };
}

const JIKAN_BASE = process.env.JIKAN_BASE_URL ?? "https://api.jikan.moe/v4";

async function browseJikan(page: number, limit: number, filters: {
  q?: string; year?: number; season?: string; type?: string; status?: string;
  start_date?: string; end_date?: string;
}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(Math.min(limit, 25)) });
  if (filters.q)          qs.set("q", filters.q);
  if (filters.year)       qs.set("start_date", `${filters.year}-01-01`);
  if (filters.start_date) qs.set("start_date", filters.start_date);
  if (filters.end_date)   qs.set("end_date", filters.end_date);
  if (filters.season)     qs.set("season", filters.season);
  if (filters.type)       qs.set("type", filters.type);
  if (filters.status)     qs.set("status", filters.status === "Finished Airing" ? "complete" : "airing");
  qs.set("order_by", "score");
  qs.set("sort", "desc");

  const url = `${JIKAN_BASE}/anime?${qs.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jikan browse returned ${res.status}`);

  const json = await res.json() as {
    data: JikanAnimeRaw[];
    pagination: { items: { count: number; total: number; per_page: number }; last_visible_page: number; has_next_page: boolean };
  };

  // Background-cache fetched anime into our DB (fire-and-forget)
  void Promise.all(
    (json.data ?? []).map(a => upsertFromCatalog(mapJikanRaw(a)).catch(() => {}))
  );

  const perPage = json.pagination?.items?.per_page ?? limit;
  const total   = json.pagination?.items?.total ?? 0;
  const pages   = json.pagination?.last_visible_page ?? Math.ceil(total / perPage);

  return {
    data: (json.data ?? []).map(mapJikanRaw),
    meta: { total, page, limit: perPage, pages },
  };
}

export async function browse(query: BrowseQuery) {
  const cacheKey = `anime:browse:${JSON.stringify(query)}`;
  const cached = cache.get<{ data: unknown[]; meta: unknown }>(cacheKey);
  if (cached) return cached;

  const { q, year, season, type, status, studio, start_date, end_date, page, limit, genre } = query as typeof query & { genre?: string };
  const hasFilters = !!(q || year || season || type || status || studio || start_date || end_date || genre);

  // ── No filters: prefer local DB (fast, ~50ms) when it has enough rows
  // for this page; only fall through to Jikan when the DB is sparse. Jikan
  // round-trips run 5-8s end-to-end from us-east-1, so the previous "always
  // Jikan on the cold path" cost every 3rd-minute visitor a multi-second
  // page wait. Local DB serves immediately and the topAnime catalog seed
  // keeps it warm.
  if (!hasFilters) {
    const { skip, take } = paginate(page, limit);
    const [localData, localTotal] = await prisma.$transaction([
      prisma.anime.findMany({
        skip, take, include: animeInclude,
        orderBy: { score: { sort: "desc", nulls: "last" } },
      }),
      prisma.anime.count(),
    ]);

    if (localData.length === take) {
      const result = {
        data: (localData as AnimeWithRelations[]).map((a) => flattenAnime(a)),
        meta: buildMeta(localTotal, page, limit),
      };
      cache.set(cacheKey, result, 15 * 60_000); // 15 min — local data is stable
      return result;
    }

    // DB doesn't have a full page → fall back to Jikan and cache aggressively.
    // Jikan's top-list is stable so a longer TTL is safe.
    try {
      const result = await browseJikan(page, limit, {});
      cache.set(cacheKey, result, 30 * 60_000); // 30 min (was 3 min)
      return result;
    } catch {
      // Jikan unavailable → serve whatever DB has rather than 500.
      const result = {
        data: (localData as AnimeWithRelations[]).map((a) => flattenAnime(a)),
        meta: buildMeta(localTotal, page, limit),
      };
      cache.set(cacheKey, result, 60_000); // short cache on degraded path
      return result;
    }
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

  // If DB has no results for a filtered query → try Jikan as fallback
  if (total === 0 && hasFilters) {
    try {
      // studio filter uses local DB only — Jikan has no studio text-search param
      const jikanResult = await browseJikan(page, limit, { q: q ?? studio, year, season, type, status, start_date, end_date });
      cache.set(cacheKey, jikanResult, 3 * 60_000);
      return jikanResult;
    } catch { /* ignore */ }
  }

  const result = {
    data: (data as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
    meta: buildMeta(total, page, limit),
  };
  cache.set(cacheKey, result, 5 * 60_000);
  return result;
}

// ─── getById ──────────────────────────────────────────────────────────────────

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function getById(malId: number, userId?: string) {
  // Only cache for unauthenticated requests (no userId) since listEntry is user-specific
  const cacheKey = `anime:${malId}`;
  if (!userId) {
    const cached = cache.get<{ anime: ReturnType<typeof flattenAnime>; listEntry: null }>(cacheKey);
    if (cached) return cached;
  }

  let anime = await prisma.anime.findUnique({
    where: { malId },
    include: animeInclude,
  });

  const isStale = !anime || Date.now() - anime.updatedAt.getTime() > STALE_AFTER_MS;

  if (isStale) {
    const catalogData = await catalog.getAnimeByMalId(malId);
    if (!catalogData) {
      if (!anime) throw notFound("Anime not found");
    } else {
      await upsertFromCatalog(catalogData);
      anime = await prisma.anime.findUnique({
        where: { malId },
        include: animeInclude,
      });
    }
  }

  if (!anime) throw notFound("Anime not found");

  const flat = flattenAnime(anime as AnimeWithRelations);

  let listEntry = null;
  if (userId) {
    listEntry = await prisma.listEntry.findUnique({
      where: { userId_animeId: { userId, animeId: anime.id } },
    });
  }

  const result = { anime: flat, listEntry };

  if (!userId) {
    cache.set(cacheKey, result, 7 * 24 * 60 * 60_000); // 7 days
  }

  return result;
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
    const items = await catalog.getSeasonal(year, season);
    if (items.length > 0) {
      await Promise.all(items.map((item) => upsertFromCatalog(item)));
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

  if (local.length >= 1) {
    cache.set(cacheKey, local, 10 * 60_000) // 10 min
    return local
  }

  // Upstream fallback
  try {
    const upstream = await catalog.searchAnime(q, { limit: 10 })
    for (const a of upstream) {
      await upsertFromCatalog(a)
    }
    const refreshed = await prisma.anime.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
      take: 20,
    })
    cache.set(cacheKey, refreshed, 10 * 60_000)
    return refreshed
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
  const result = await prisma.anime.findMany({
    where: { score: { not: null } },
    orderBy: [{ status: "asc" }, { score: { sort: "desc", nulls: "last" } }], // airing first, then by score
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

export async function getCharacters(malId: number) {
  const key = `anime:characters:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}/characters`)
  if (!res.ok) return { data: [] }
  const data = await res.json()
  cache.set(key, data, 60 * 60_000) // 1 hour
  return data
}

// ─── getStaff ────────────────────────────────────────────────────────────────

export async function getStaff(malId: number) {
  const key = `anime:staff:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}/staff`)
  if (!res.ok) return { data: [] }
  const data = await res.json()
  cache.set(key, data, 60 * 60_000)
  return data
}

// ─── getEpisodes ──────────────────────────────────────────────────────────────

export async function getEpisodes(malId: number, page = 1) {
  const key = `anime:episodes:${malId}:${page}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}/episodes?page=${page}`)
  if (!res.ok) return { data: [], pagination: { last_visible_page: 1, has_next_page: false } }
  const data = await res.json()
  cache.set(key, data, 30 * 60_000) // 30 min
  return data
}

// ─── getFranchise ────────────────────────────────────────────────────────────

export async function getFranchise(malId: number) {
  const key = `anime:franchise:${malId}`
  const cached = cache.get<unknown>(key)
  if (cached) return cached
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}/relations`)
  if (!res.ok) return { data: [] }
  const data = await res.json()
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
    const items = await catalog.searchAnime(q, { limit: 10 });
    await Promise.all(items.map((item) => upsertFromCatalog(item)));
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
