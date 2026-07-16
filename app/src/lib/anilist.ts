/**
 * AniList GraphQL helper — manga search for the reading list. AniList's public
 * GraphQL API needs no key and covers manga (which isn't in our anime catalog).
 */

export type AniListManga = {
  anilistId: number;
  title: string;
  coverUrl: string | null;
  author: string | null;
  format: string | null;
  totalChapters: number | null;
  genre: string | null;
};

const ENDPOINT = "https://graphql.anilist.co";

const SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 24) {
    media(search: $search, type: MANGA, sort: POPULARITY_DESC, isAdult: false) {
      id
      title { english romaji }
      coverImage { large }
      chapters
      format
      genres
      staff(perPage: 4, sort: RELEVANCE) {
        edges { role node { name { full } } }
      }
    }
  }
}`;

type RawMedia = {
  id: number;
  title: { english: string | null; romaji: string | null };
  coverImage: { large: string | null } | null;
  chapters: number | null;
  format: string | null;
  genres: string[] | null;
  staff: { edges: Array<{ role: string | null; node: { name: { full: string | null } } }> } | null;
};

function pickAuthor(staff: RawMedia["staff"]): string | null {
  if (!staff?.edges?.length) return null;
  // Prefer the "Story" / "Story & Art" credit; else the first listed staff.
  const story = staff.edges.find(e => /story/i.test(e.role ?? ""));
  return (story ?? staff.edges[0])?.node?.name?.full ?? null;
}

// ─── Catalog-shaped search (manga search top-up fallback) ────────────────────
// Jikan's /manga?q= endpoint has a history of persistent 504 outages while
// /manga/{id}/full stays up. This search returns idMal so the local catalog
// can stub MAL-keyed rows and let the sync queue fill full detail later.

export type AniListMangaStub = {
  malId: number;
  title: string; // romaji (matches MAL's default title convention)
  titleEnglish: string | null;
  synonyms: string[];
  coverUrl: string | null;
  chapters: number | null;
  volumes: number | null;
  format: string | null;
  genres: string[];
  meanScore: number | null;
};

const CATALOG_SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      idMal
      title { english romaji }
      synonyms
      coverImage { large }
      chapters
      volumes
      format
      genres
      meanScore
    }
  }
}`;

export async function searchMangaStubs(query: string): Promise<AniListMangaStub[]> {
  const term = query.trim();
  if (!term) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: CATALOG_SEARCH_QUERY, variables: { search: term } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`AniList catalog search failed (${res.status})`);
  const json = (await res.json()) as {
    data?: {
      Page?: {
        media?: Array<{
          idMal: number | null;
          title: { english: string | null; romaji: string | null };
          synonyms: string[] | null;
          coverImage: { large: string | null } | null;
          chapters: number | null;
          volumes: number | null;
          format: string | null;
          genres: string[] | null;
          meanScore: number | null;
        }>;
      };
    };
  };
  return (json.data?.Page?.media ?? [])
    .filter((m) => m.idMal) // MAL-keyed catalog — AniList-only titles are skipped
    .map((m) => ({
      malId: m.idMal as number,
      title: m.title.romaji || m.title.english || "Untitled",
      titleEnglish: m.title.english ?? null,
      synonyms: m.synonyms ?? [],
      coverUrl: m.coverImage?.large ?? null,
      chapters: m.chapters ?? null,
      volumes: m.volumes ?? null,
      format: m.format ?? null,
      genres: m.genres ?? [],
      meanScore: m.meanScore ?? null,
    }));
}

const MAL_IDS_QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, type: MANGA) { id idMal }
  }
}`;

/** Resolve AniList manga ids → MAL ids (for linking legacy readlist entries
 *  to the local Manga catalog). Batches of 50; missing idMal → null. */
export async function getMangaMalIds(anilistIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (let i = 0; i < anilistIds.length; i += 50) {
    const batch = anilistIds.slice(i, i + 50);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: MAL_IDS_QUERY, variables: { ids: batch } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`AniList idMal lookup failed (${res.status})`);
    const json = (await res.json()) as { data?: { Page?: { media?: Array<{ id: number; idMal: number | null }> } } };
    for (const m of json.data?.Page?.media ?? []) out.set(m.id, m.idMal ?? null);
  }
  return out;
}

export async function searchManga(query: string): Promise<AniListManga[]> {
  const term = query.trim();
  if (!term) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: term } }),
  });
  if (!res.ok) throw new Error(`AniList search failed (${res.status})`);
  const json = (await res.json()) as { data?: { Page?: { media?: RawMedia[] } } };
  const media = json.data?.Page?.media ?? [];
  return media.map((m) => ({
    anilistId: m.id,
    title: m.title.english || m.title.romaji || "Untitled",
    coverUrl: m.coverImage?.large ?? null,
    author: pickAuthor(m.staff),
    format: m.format ?? null,
    totalChapters: m.chapters ?? null,
    genre: m.genres?.[0] ?? null,
  }));
}
