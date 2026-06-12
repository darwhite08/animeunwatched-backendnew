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
