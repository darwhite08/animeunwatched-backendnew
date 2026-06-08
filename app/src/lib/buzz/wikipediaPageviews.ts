/**
 * Wikimedia pageviews collector — off-platform general-public interest. People
 * read a show's Wikipedia article when it's hot, so recent pageview velocity is
 * a strong free buzz proxy.
 *
 * Verified constraints (deep research): Wikimedia REST allows 200 req/min with a
 * User-Agent (no key); the earlier "anonymous 500/hr" figure was refuted. We
 * pace ~3 req/sec and only query the bounded candidate set on an hourly cadence.
 *
 * Title resolution is best-effort (English then romaji, underscored); a 404 just
 * means "no confident article" → that title contributes no Wikipedia signal.
 */
import { env } from "../../config/env";

const REST = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user";
const DECAY_HALF_LIFE_DAYS = 3; // recent days dominate (buzz = rising interest)
const WINDOW_DAYS = 10;
const FETCH_TIMEOUT_MS = 6_000; // keep the hourly job bounded even on slow responses
const MAX_CANDIDATES = 120; // cap external calls so the job can't overrun its hourly window

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve an anime's best English Wikipedia article via MediaWiki search,
 * biased toward the anime article with an " anime" hint. Returns the canonical
 * article title (handles redirects/disambiguation that raw title-guessing
 * misses), or null if no confident match. One call; the result is cached on the
 * Anime row so we never resolve the same title twice.
 */
export async function resolveWikipediaArticle(title: string): Promise<string | null> {
  const q = encodeURIComponent(`${title} anime`);
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=1&srnamespace=0&srsearch=${q}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": env.TRENDING_USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as { query?: { search?: Array<{ title: string }> } };
    return json.query?.search?.[0]?.title ?? null;
  } catch {
    return null;
  }
}

interface PageviewItem { timestamp: string; views: number }

async function fetchArticleDecayedViews(article: string, start: string, end: string): Promise<number | null> {
  const url = `${REST}/${article}/daily/${start}/${end}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": env.TRENDING_USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null; // timeout / network — best-effort miss
  }
  if (res.status === 404) return null; // no such article — best-effort miss
  if (res.status === 429) { await sleep(2000); return null; }
  if (!res.ok) return null;

  const json = (await res.json()) as { items?: PageviewItem[] };
  const items = json.items ?? [];
  if (items.length === 0) return null;

  // Decayed-weight daily views so a recent surge outranks a flat-but-popular page.
  const lambda = Math.LN2 / DECAY_HALF_LIFE_DAYS;
  const today = Date.now();
  let decayed = 0;
  for (const it of items) {
    // timestamp is YYYYMMDD00
    const y = +it.timestamp.slice(0, 4), m = +it.timestamp.slice(4, 6), d = +it.timestamp.slice(6, 8);
    const ageDays = Math.max(0, (today - Date.UTC(y, m - 1, d)) / 86_400_000);
    decayed += it.views * Math.exp(-lambda * ageDays);
  }
  return decayed;
}

/** A candidate with its already-resolved Wikipedia article (from the cache). */
export interface ResolvedWikiCandidate { malId: number; article: string }

/**
 * For each candidate (with a resolved article), returns a normalized
 * decayed-pageview value in [0,1] (relative to the batch p95).
 */
export async function fetchPageviewBuzz(candidates: ResolvedWikiCandidate[]): Promise<Map<number, number>> {
  const end = ymd(new Date(Date.now() - 86_400_000)); // yesterday (today is partial)
  const start = ymd(new Date(Date.now() - WINDOW_DAYS * 86_400_000));

  // Cap so a slow Wikimedia run can't overrun the hourly window. Callers pass
  // candidates already ordered by importance.
  const bounded = candidates.slice(0, MAX_CANDIDATES);

  const raw = new Map<number, number>();
  for (const c of bounded) {
    const article = encodeURIComponent(c.article.replace(/\s+/g, "_"));
    const v = await fetchArticleDecayedViews(article, start, end);
    await sleep(320); // ~3 req/sec, under the 200/min limit
    if (v != null) raw.set(c.malId, v);
  }

  // Normalize by batch p95 → 0..1 (so one mega-page doesn't crush the rest).
  const vals = [...raw.values()].sort((a, b) => a - b);
  if (vals.length === 0) return raw;
  const p95 = vals[Math.min(vals.length - 1, Math.ceil(0.95 * vals.length) - 1)] || 1;
  const out = new Map<number, number>();
  for (const [malId, v] of raw) out.set(malId, Math.min(1, v / p95));
  return out;
}
