/**
 * Jikan manga payload → internal shapes. Pure functions, no I/O — Prisma
 * writes happen in modules/manga/mangaSync.service.ts. Mirrors jikan.mapper.ts.
 */
import type { JikanManga, JikanMalEntity } from "./jikanClient";
import { buildSearchText } from "../searchText";
import type { MappedGenre } from "./jikan.mapper";

/** Scalar columns of the Manga row that sync is allowed to write.
 *  Deliberately excludes slug (create-only). */
export interface MappedMangaScalars {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  titleSynonyms: string[];
  searchText: string;
  synopsis: string | null;
  background: string | null;
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
  scoredBy: number | null;
  rank: number | null;
  popularity: number | null;
  membersCount: number | null;
  favoritesCount: number | null;
  imageUrl: string | null;
  imageSmallUrl: string | null;
  imageWebpUrl: string | null;
}

export function mapMangaScalars(m: JikanManga): MappedMangaScalars {
  return {
    malId: m.mal_id,
    title: m.title ?? "",
    titleEnglish: m.title_english ?? null,
    titleJapanese: m.title_japanese ?? null,
    titleSynonyms: m.title_synonyms ?? [],
    searchText: buildSearchText({
      title: m.title,
      titleEnglish: m.title_english,
      titleJapanese: m.title_japanese,
      titleSynonyms: m.title_synonyms,
    }),
    synopsis: m.synopsis ?? null,
    background: m.background ?? null,
    type: m.type ?? null,
    chapters: m.chapters ?? null,
    volumes: m.volumes ?? null,
    status: m.status ?? null,
    publishing: m.publishing ?? false,
    publishedFrom: m.published?.from ? new Date(m.published.from) : null,
    publishedTo: m.published?.to ? new Date(m.published.to) : null,
    demographic: m.demographics?.[0]?.name ?? null,
    authors: (m.authors ?? []).map((a) => a.name).filter(Boolean),
    serializations: (m.serializations ?? []).map((s) => s.name).filter(Boolean),
    // /manga list payloads say `scored`; /manga/{id}/full says `score`.
    score: m.score ?? m.scored ?? null,
    scoredBy: m.scored_by ?? null,
    rank: m.rank ?? null,
    popularity: m.popularity ?? null,
    membersCount: m.members ?? null,
    favoritesCount: m.favorites ?? null,
    imageUrl: m.images?.jpg?.large_image_url ?? m.images?.jpg?.image_url ?? null,
    imageSmallUrl: m.images?.jpg?.small_image_url ?? null,
    imageWebpUrl: m.images?.webp?.large_image_url ?? m.images?.webp?.image_url ?? null,
  };
}

function bucket(entries: JikanMalEntity[] | null | undefined, type: string): MappedGenre[] {
  return (entries ?? []).map((e) => ({ malId: e.mal_id, name: e.name, type }));
}

/** Same four Jikan genre buckets as anime — includes demographics so
 *  shounen/seinen/josei (and Boys Love, which arrives as a plain genre)
 *  are all filterable via the shared Genre table. */
export function mapMangaGenres(m: JikanManga): MappedGenre[] {
  return [
    ...bucket(m.genres, "genre"),
    ...bucket(m.explicit_genres, "explicit_genre"),
    ...bucket(m.themes, "theme"),
    ...bucket(m.demographics, "demographic"),
  ];
}

// ─── Sync priority ────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * HOT    — currently publishing, or starts publishing within 60 days
 * COLD   — finished/discontinued and ended 2+ years ago
 * NORMAL — everything else
 * (Mirrors computeSyncPriority for anime.)
 */
export function computeMangaSyncPriority(m: {
  publishing: boolean;
  status: string | null;
  publishedFrom: Date | null;
  publishedTo: Date | null;
}): "HOT" | "NORMAL" | "COLD" {
  if (m.publishing) return "HOT";
  if (
    m.status === "Not yet published" &&
    m.publishedFrom &&
    m.publishedFrom.getTime() - Date.now() < 60 * DAY_MS
  ) {
    return "HOT";
  }
  if (
    (m.status === "Finished" || m.status === "Discontinued") &&
    m.publishedTo &&
    Date.now() - m.publishedTo.getTime() > 2 * 365 * DAY_MS
  ) {
    return "COLD";
  }
  return "NORMAL";
}
