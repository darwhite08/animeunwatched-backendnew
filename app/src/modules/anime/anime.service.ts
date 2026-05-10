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

  // Reconcile genres (delete-then-recreate diff)
  await prisma.animeGenre.deleteMany({ where: { animeId: anime.id } });
  await prisma.animeGenre.createMany({
    data: genreRecords.map((g: { id: string }) => ({ animeId: anime.id, genreId: g.id })),
    skipDuplicates: true,
  });

  // Reconcile studios
  await prisma.animeStudio.deleteMany({ where: { animeId: anime.id } });
  await prisma.animeStudio.createMany({
    data: studioRecords.map((s: { id: string }) => ({ animeId: anime.id, studioId: s.id })),
    skipDuplicates: true,
  });

  // Invalidate per-anime cache entry so next read gets fresh data
  cache.del(`anime:${data.malId}`);

  return flattenAnime(anime as AnimeWithRelations);
}

// ─── browse ───────────────────────────────────────────────────────────────────

export async function browse(query: BrowseQuery) {
  const cacheKey = `anime:browse:${JSON.stringify(query)}`;
  const cached = cache.get<{ data: ReturnType<typeof flattenAnime>[]; meta: ReturnType<typeof buildMeta> }>(cacheKey);
  if (cached) return cached;

  const { q, year, season, type, status, page, limit } = query;
  const { skip, take } = paginate(page, limit);

  const where = {
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(season ? { season } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.anime.findMany({ where, skip, take, include: animeInclude, orderBy: { score: "desc" } }),
    prisma.anime.count({ where }),
  ]);

  const result = {
    data: (data as AnimeWithRelations[]).map((a: AnimeWithRelations) => flattenAnime(a)),
    meta: buildMeta(total, page, limit),
  };

  cache.set(cacheKey, result, 5 * 60_000); // 5 min TTL
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
    prisma.anime.findMany({ where, skip, take, include: animeInclude, orderBy: { score: "desc" } }),
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

  // Local DB first
  const local = await prisma.anime.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { titleEnglish: { contains: q, mode: "insensitive" } },
        { synopsis: { contains: q, mode: "insensitive" } },
      ]
    },
    include: { genres: { include: { genre: true } }, studios: { include: { studio: true } } },
    take: 20,
    orderBy: { score: "desc" },
  })

  if (local.length >= 3) {
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
