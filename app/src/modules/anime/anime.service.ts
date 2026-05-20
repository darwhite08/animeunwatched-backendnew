import { prisma } from "../../config/prisma";
import { catalog } from "../../lib/catalog";
import type { CatalogAnime } from "../../lib/catalog/types";
import { notFound } from "../../lib/errors";
import { cache } from "../../lib/cache";
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

  const { q, year, season, type, status, studio, start_date, end_date, page, limit } = query;
  const hasFilters = !!(q || year || season || type || status || studio || start_date || end_date);

  // ── No filters: proxy Jikan directly for ALL anime with pagination ──
  if (!hasFilters) {
    try {
      const result = await browseJikan(page, limit, {});
      cache.set(cacheKey, result, 3 * 60_000); // 3 min TTL (Jikan is live data)
      return result;
    } catch {
      // Jikan unavailable → fall through to local DB
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

// ─── getSimilar ──────────────────────────────────────────────────────────────

export async function getSimilar(malId: number, limit = 12) {
  const cacheKey = `anime:similar:${malId}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const anime = await prisma.anime.findFirst({
    where: { malId },
    include: { genres: { include: { genre: true } } },
  })
  if (!anime) throw notFound("Anime not found")

  const genreIds = anime.genres.map((g: { genreId: string }) => g.genreId)
  const similar = await prisma.anime.findMany({
    where: {
      malId: { not: malId },
      genres: { some: { genreId: { in: genreIds } } },
      score: { not: null },
    },
    orderBy: { score: { sort: "desc", nulls: "last" } },
    take: limit,
    include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
  })
  cache.set(cacheKey, similar, 60 * 60_000) // 1 hour
  return similar
}

// ─── search ──────────────────────────────────────────────────────────────────

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
