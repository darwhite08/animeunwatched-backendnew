/**
 * Jikan payload → internal shapes. Pure functions, no I/O — Prisma writes
 * happen in modules/anime/animeSync.service.ts.
 */
import type { CatalogAnime } from "./types";
import type { JikanAnime, JikanEpisode, JikanMalEntity } from "./jikanClient";

/** Jikan often leaves trailer.youtube_id null but provides embed_url — pull the
 *  11-char video id out of either. */
export function ytIdFromTrailer(t?: { youtube_id?: string | null; embed_url?: string | null } | null): string | null {
  if (!t) return null;
  if (t.youtube_id) return t.youtube_id;
  const m = t.embed_url?.match(/\/embed\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

// ─── Legacy CatalogAnime mapping (browse/search/seasonal paths) ──────────────

export function mapJikanToCatalog(data: Record<string, unknown>): CatalogAnime {
  const aired = (data.aired ?? {}) as Record<string, string | null>;
  const images = (data.images ?? {}) as Record<string, Record<string, string | null>>;
  const trailer = (data.trailer ?? {}) as Record<string, string | null>;
  const genres = (data.genres as Array<{ name: string }> | null) ?? [];
  const studios = (data.studios as Array<{ name: string }> | null) ?? [];

  return {
    malId: data.mal_id as number,
    title: (data.title as string) ?? "",
    titleEnglish: (data.title_english as string | null) ?? null,
    titleJapanese: (data.title_japanese as string | null) ?? null,
    synopsis: (data.synopsis as string | null) ?? null,
    type: (data.type as string | null) ?? null,
    episodes: (data.episodes as number | null) ?? null,
    status: (data.status as string | null) ?? null,
    airedFrom: aired.from ? new Date(aired.from) : null,
    airedTo: aired.to ? new Date(aired.to) : null,
    season: (data.season as string | null) ?? null,
    year: (data.year as number | null) ?? null,
    rating: (data.rating as string | null) ?? null,
    score: (data.score as number | null) ?? null,
    imageUrl: images.jpg?.large_image_url ?? images.jpg?.image_url ?? null,
    trailerUrl: trailer.url ?? null,
    trailerYoutubeId: ytIdFromTrailer(trailer),
    source: (data.source as string | null) ?? null,
    genres: genres.map((g) => g.name),
    studios: studios.map((s) => s.name),
  };
}

// ─── Full-detail mapping (sync worker / read-through) ────────────────────────

export interface MappedGenre {
  malId: number;
  name: string;
  /** genre | explicit_genre | theme | demographic */
  type: string;
}

export interface MappedStudio {
  malId: number;
  name: string;
  /** studio | producer | licensor */
  role: string;
}

export interface MappedRelation {
  targetMalId: number;
  relationType: string;
}

/** Scalar columns of the Anime row that sync is allowed to write.
 *  Deliberately excludes Kaiveron enrichment (kaiveronTags, waieScore,
 *  isFeatured, localImagePath) and slug (create-only). */
export interface MappedAnimeScalars {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  titleSynonyms: string[];
  synopsis: string | null;
  background: string | null;
  type: string | null;
  episodes: number | null;
  status: string | null;
  airing: boolean;
  airedFrom: Date | null;
  airedTo: Date | null;
  duration: string | null;
  season: string | null;
  year: number | null;
  rating: string | null;
  score: number | null;
  scoredBy: number | null;
  rank: number | null;
  popularity: number | null;
  membersCount: number | null;
  favoritesCount: number | null;
  imageUrl: string | null;
  imageSmallUrl: string | null;
  imageWebpUrl: string | null;
  trailerUrl: string | null;
  trailerYoutubeId: string | null;
  broadcastDay: string | null;
  broadcastTime: string | null;
  broadcastTz: string | null;
  source: string | null;
}

export function mapAnimeScalars(a: JikanAnime): MappedAnimeScalars {
  return {
    malId: a.mal_id,
    title: a.title ?? "",
    titleEnglish: a.title_english ?? null,
    titleJapanese: a.title_japanese ?? null,
    titleSynonyms: a.title_synonyms ?? [],
    synopsis: a.synopsis ?? null,
    background: a.background ?? null,
    type: a.type ?? null,
    episodes: a.episodes ?? null,
    status: a.status ?? null,
    airing: a.airing ?? false,
    airedFrom: a.aired?.from ? new Date(a.aired.from) : null,
    airedTo: a.aired?.to ? new Date(a.aired.to) : null,
    duration: a.duration ?? null,
    season: a.season ?? null,
    year: a.year ?? null,
    rating: a.rating ?? null,
    score: a.score ?? null,
    scoredBy: a.scored_by ?? null,
    rank: a.rank ?? null,
    popularity: a.popularity ?? null,
    membersCount: a.members ?? null,
    favoritesCount: a.favorites ?? null,
    imageUrl: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
    imageSmallUrl: a.images?.jpg?.small_image_url ?? null,
    imageWebpUrl: a.images?.webp?.large_image_url ?? a.images?.webp?.image_url ?? null,
    trailerUrl: a.trailer?.url ?? null,
    trailerYoutubeId: ytIdFromTrailer(a.trailer),
    broadcastDay: a.broadcast?.day ?? null,
    broadcastTime: a.broadcast?.time ?? null,
    broadcastTz: a.broadcast?.timezone ?? null,
    source: a.source ?? null,
  };
}

function bucket(entries: JikanMalEntity[] | null | undefined, type: string): MappedGenre[] {
  return (entries ?? []).map((e) => ({ malId: e.mal_id, name: e.name, type }));
}

/** Jikan splits genres into four buckets; we keep the bucket as Genre.type. */
export function mapGenres(a: JikanAnime): MappedGenre[] {
  return [
    ...bucket(a.genres, "genre"),
    ...bucket(a.explicit_genres, "explicit_genre"),
    ...bucket(a.themes, "theme"),
    ...bucket(a.demographics, "demographic"),
  ];
}

function companies(entries: JikanMalEntity[] | null | undefined, role: string): MappedStudio[] {
  return (entries ?? []).map((e) => ({ malId: e.mal_id, name: e.name, role }));
}

export function mapStudios(a: JikanAnime): MappedStudio[] {
  return [
    ...companies(a.studios, "studio"),
    ...companies(a.producers, "producer"),
    ...companies(a.licensors, "licensor"),
  ];
}

/** Only anime→anime relations are persisted (manga adaptations etc. have no
 *  local row to point at). */
export function mapRelations(a: JikanAnime): MappedRelation[] {
  const out: MappedRelation[] = [];
  for (const rel of a.relations ?? []) {
    for (const entry of rel.entry ?? []) {
      if (entry.type === "anime") {
        out.push({ targetMalId: entry.mal_id, relationType: rel.relation });
      }
    }
  }
  return out;
}

export interface MappedEpisode {
  malEpisodeId: number;
  title: string | null;
  titleJapanese: string | null;
  titleRomaji: string | null;
  aired: Date | null;
  score: number | null;
  filler: boolean;
  recap: boolean;
  synopsis: string | null;
}

export function mapEpisode(e: JikanEpisode): MappedEpisode {
  return {
    malEpisodeId: e.mal_id,
    title: e.title ?? null,
    titleJapanese: e.title_japanese ?? null,
    titleRomaji: e.title_romanji ?? null,
    aired: e.aired ? new Date(e.aired) : null,
    score: e.score ?? null,
    filler: e.filler ?? false,
    recap: e.recap ?? false,
    synopsis: e.synopsis ?? null,
  };
}

// ─── Sync priority ────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * HOT    — airing now, or premieres within 60 days
 * COLD   — finished and ended 2+ years ago
 * NORMAL — everything else
 */
export function computeSyncPriority(a: {
  airing: boolean;
  status: string | null;
  airedFrom: Date | null;
  airedTo: Date | null;
}): "HOT" | "NORMAL" | "COLD" {
  if (a.airing) return "HOT";
  if (
    a.status === "Not yet aired" &&
    a.airedFrom &&
    a.airedFrom.getTime() - Date.now() < 60 * DAY_MS
  ) {
    return "HOT";
  }
  if (
    a.status === "Finished Airing" &&
    a.airedTo &&
    Date.now() - a.airedTo.getTime() > 2 * 365 * DAY_MS
  ) {
    return "COLD";
  }
  return "NORMAL";
}
