/**
 * AniList TRENDING_DESC collector — off-platform "what's trending across the
 * anime web right now". AniList computes this from its own millions of users'
 * real-time activity; each entry carries `idMal`, so mapping to our catalog is
 * EXACT (no fuzzy title matching).
 *
 * Verified constraints (deep research): AniList GraphQL is rate-limited
 * (30 req/min degraded, 90 normal). We pull a few pages (~150 titles) per run
 * on an hourly cadence — trivially within budget. Returns a normalized 0..1
 * buzz value per malId (relative to the top trending title this run).
 */
import { env } from "../../config/env";

const ANILIST_URL = "https://graphql.anilist.co";

const QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: TRENDING_DESC) {
      idMal
      trending
    }
  }
}`;

interface AniListMedia {
  idMal: number | null;
  trending: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(page: number): Promise<{ media: AniListMedia[]; hasNext: boolean }> {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": env.TRENDING_USER_AGENT,
    },
    body: JSON.stringify({ query: QUERY, variables: { page } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    // Honour Retry-After then signal "no data, stop" to the caller.
    const retry = Number(res.headers.get("retry-after")) || 60;
    await sleep(Math.min(retry, 60) * 1000);
    return { media: [], hasNext: false };
  }
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = (await res.json()) as { data?: { Page?: { pageInfo?: { hasNextPage?: boolean }; media?: AniListMedia[] } } };
  return {
    media: json.data?.Page?.media ?? [],
    hasNext: json.data?.Page?.pageInfo?.hasNextPage ?? false,
  };
}

/**
 * Returns a map malId → normalized trending value in [0,1] (relative to the
 * hottest title this run). `pages` defaults to 3 (~150 titles).
 */
export async function fetchAniListTrending(pages = 3): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const raw: Array<{ malId: number; trending: number }> = [];

  for (let p = 1; p <= pages; p++) {
    const { media, hasNext } = await fetchPage(p);
    for (const m of media) {
      if (m.idMal && (m.trending ?? 0) > 0) raw.push({ malId: m.idMal, trending: m.trending! });
    }
    if (!hasNext) break;
    await sleep(1200); // stay well under 30 req/min
  }

  const max = raw.reduce((acc, r) => Math.max(acc, r.trending), 0);
  if (max <= 0) return out;
  // Log-scale then normalize: AniList trending is heavy-tailed (One Piece can be
  // 3-4× the rest), so log keeps a mid-tier spike from being crushed to ~0.
  const logMax = Math.log10(1 + max);
  for (const r of raw) {
    out.set(r.malId, Math.min(1, Math.log10(1 + r.trending) / logMax));
  }
  return out;
}
