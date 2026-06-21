/**
 * YouTube trailer resolver.
 *
 * Finds the genuine OFFICIAL trailer/PV for an anime on YouTube and caches the
 * video id into Anime.trailerYoutubeId. Two-stage pipeline:
 *
 *   1. Heuristic scoring — shortlist candidates by official-channel signals,
 *      trailer/PV keywords, title match and duration sanity; penalise reactions,
 *      AMVs, reviews, edits, OP/ED, full episodes, etc.
 *   2. AI pick — hand the top few candidates to the LLM (Claude → OpenAI) and
 *      let it choose the single official trailer (or NONE). Falls back to the
 *      top-scored heuristic candidate when no AI key is configured.
 *
 * Entirely inert until YOUTUBE_API_KEY is set, so it ships dormant and the
 * existing DB-backed /trailers gallery keeps working unchanged.
 *
 * Quota note: search.list costs 100 units (10k/day default ≈ 100 searches/day),
 * videos.list costs ~1. The backfill is therefore batched + popularity-ordered
 * and records trailerCheckedAt so misses are not re-queried.
 */
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { askLLM } from "../ai/ai.service";

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const ytKey = (): string | undefined => process.env.YOUTUBE_API_KEY;

export function youtubeTrailersEnabled(): boolean {
  return Boolean(ytKey());
}

type Candidate = {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  durationSec: number;
};

type AnimeLite = {
  malId: number;
  title: string;
  titleEnglish?: string | null;
  year?: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ISO-8601 duration (PT1M30S) → seconds. */
function parseIsoDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/** search.list → videos.list to enrich with duration; embeddable + public only. */
async function searchCandidates(query: string): Promise<Candidate[]> {
  const key = ytKey();
  if (!key) return [];
  try {
    const sUrl =
      `${YT_BASE}/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=none` +
      `&maxResults=10&q=${encodeURIComponent(query)}&key=${key}`;
    const sRes = await fetch(sUrl);
    if (!sRes.ok) return [];
    const sData = (await sRes.json()) as {
      items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }>;
    };
    const items = sData.items ?? [];
    const ids = items.map((i) => i.id?.videoId).filter((x): x is string => Boolean(x));
    if (!ids.length) return [];

    const vUrl = `${YT_BASE}/videos?part=contentDetails,status&id=${ids.join(",")}&key=${key}`;
    const vRes = await fetch(vUrl);
    const vData = vRes.ok
      ? ((await vRes.json()) as { items?: Array<{ id: string; contentDetails?: { duration?: string }; status?: { embeddable?: boolean; privacyStatus?: string } }> })
      : { items: [] };
    const detail = new Map((vData.items ?? []).map((it) => [it.id, it]));

    return items
      .map((i) => {
        const videoId = i.id!.videoId!;
        const d = detail.get(videoId);
        return {
          videoId,
          title: i.snippet?.title ?? "",
          channel: i.snippet?.channelTitle ?? "",
          publishedAt: i.snippet?.publishedAt ?? "",
          durationSec: parseIsoDuration(d?.contentDetails?.duration ?? ""),
          _embeddable: d?.status?.embeddable !== false && d?.status?.privacyStatus !== "private",
        };
      })
      .filter((c) => c._embeddable)
      .map(({ _embeddable, ...c }) => c);
  } catch {
    return [];
  }
}

const OFFICIAL_CHANNELS =
  /(crunchyroll|aniplex|muse (asia|africa)?|netflix|toho animation|bandai|sunrise|funimation|sentai|ufotable|mappa|wit studio|kadokawa|pony canyon|kana ?home video|medialink|ani-?one|sony pictures|hidive|gkids|cloverworks|trigger|madhouse|production i\.?g|official)/i;

const NEGATIVE =
  /\b(reaction|react|amv|\bmad\b|review|recap|explained|breakdown|edit|fan[\s-]?made|fanmade|opening|ending|\bop\b|\bed\b|\bost\b|theme song|music video|lyrics|full episode|episode \d|ep\.? ?\d|all openings|compilation|tier ?list|ranking|top \d|whodunit|cosplay|live action|trailer reaction)\b/i;

const POSITIVE_STRONG = /\b(official (trailer|pv)|main trailer|main pv|character pv)\b/i;
const POSITIVE = /\b(trailer|teaser|\bpv\b|promotional video|first look|announcement)\b/i;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2);
}

/** Heuristic 0–100ish score; negative means almost certainly not a trailer. */
function scoreCandidate(c: Candidate, anime: AnimeLite): number {
  const t = c.title.toLowerCase();
  const names = [anime.titleEnglish, anime.title].filter((x): x is string => Boolean(x)).map((s) => s.toLowerCase());
  let s = 0;

  // Title match
  if (names.some((n) => t.includes(n))) s += 40;
  else {
    const tk = new Set(tokens(t));
    const best = Math.max(
      0,
      ...names.map((n) => {
        const nt = tokens(n);
        return nt.length ? nt.filter((w) => tk.has(w)).length / nt.length : 0;
      }),
    );
    s += Math.round(best * 30);
  }

  // Trailer-ness
  if (POSITIVE_STRONG.test(t)) s += 35;
  else if (POSITIVE.test(t)) s += 24;
  else s -= 10; // no trailer word at all

  if (OFFICIAL_CHANNELS.test(c.channel)) s += 25;
  if (t.includes("anime")) s += 4;

  // Duration sanity — trailers are short
  if (c.durationSec >= 8 && c.durationSec <= 240) s += 15;
  else if (c.durationSec > 600) s -= 35;
  else if (c.durationSec > 0 && c.durationSec < 8) s -= 10;

  if (NEGATIVE.test(t)) s -= 60;

  return s;
}

/** Ask the LLM to pick the single official trailer id among the shortlist. */
async function aiPick(anime: AnimeLite, cands: Candidate[]): Promise<string | null> {
  if (!cands.length) return null;
  const list = cands
    .map((c, i) => `${i + 1}. id=${c.videoId} | "${c.title}" | channel=${c.channel} | ${c.durationSec}s`)
    .join("\n");
  const system =
    "You select the single OFFICIAL trailer/PV (promotional video) or teaser for a specific anime from a list of YouTube candidates. " +
    "Ignore reactions, AMVs, reviews, edits, openings/endings, full episodes and videos for a different anime. " +
    "Reply with ONLY the 11-character video id (the value after 'id=') of the best official trailer, or the single word NONE. No other text.";
  const user =
    `Anime: ${anime.titleEnglish || anime.title}${anime.year ? ` (${anime.year})` : ""}\n` +
    `Original title: ${anime.title}\n\nCandidates:\n${list}\n\nWhich id is the official trailer/PV? Reply with the id or NONE.`;

  const out = await askLLM(system, user, 30);
  if (!out) return null;
  if (/^\s*none\s*$/i.test(out)) return null;
  const m = out.match(/[A-Za-z0-9_-]{11}/);
  const id = m?.[0];
  return id && cands.some((c) => c.videoId === id) ? id : null;
}

/**
 * Resolve the best official trailer video id for an anime, or null.
 * Combines heuristic shortlisting with an AI final pick.
 */
export async function resolveTrailer(anime: AnimeLite): Promise<string | null> {
  if (!ytKey()) return null;
  const name = anime.titleEnglish || anime.title;
  const cands = await searchCandidates(`${name} anime official trailer PV`);
  if (!cands.length) return null;

  const ranked = cands
    .map((c) => ({ c, s: scoreCandidate(c, anime) }))
    .sort((a, b) => b.s - a.s)
    .filter((r) => r.s > 5);
  if (!ranked.length) return null;

  const shortlist = ranked.slice(0, 5).map((r) => r.c);
  const picked = await aiPick(anime, shortlist);
  return picked ?? shortlist[0].videoId;
}

/**
 * Backfill trailers for the most popular anime that don't have one yet.
 * Popularity-ordered, quota-bounded, and records trailerCheckedAt so a miss is
 * not re-queried for `recheckDays`. Returns counts for the job log.
 */
export async function backfillTrailers(limit = 80, recheckDays = 45): Promise<{ scanned: number; resolved: number; skipped: boolean }> {
  if (!ytKey()) return { scanned: 0, resolved: 0, skipped: true };

  const recheckBefore = new Date(Date.now() - recheckDays * 24 * 60 * 60_000);
  const rows = await prisma.anime.findMany({
    where: {
      trailerYoutubeId: null,
      OR: [{ trailerCheckedAt: null }, { trailerCheckedAt: { lt: recheckBefore } }],
    },
    orderBy: [
      { trendingScore: "desc" },
      { score: { sort: "desc", nulls: "last" } },
      { membersCount: { sort: "desc", nulls: "last" } },
    ],
    take: Math.min(150, Math.max(1, limit)),
    select: { malId: true, title: true, titleEnglish: true, year: true },
  });

  let resolved = 0;
  for (const a of rows) {
    const id = await resolveTrailer(a).catch(() => null);
    await prisma.anime.update({
      where: { malId: a.malId },
      data: { trailerCheckedAt: new Date(), ...(id ? { trailerYoutubeId: id } : {}) },
    });
    if (id) resolved++;
    await sleep(120);
  }
  return { scanned: rows.length, resolved, skipped: false };
}

// In-process guard so concurrent views of the same anime don't fire duplicate
// YouTube lookups before the first one writes trailerCheckedAt.
const inFlight = new Set<number>();

/**
 * Lazy, on-demand trailer resolution for a SINGLE anime — call fire-and-forget
 * from the detail endpoint. This is how trailers reach EVERY anime users
 * actually open (not just the popular backfill set), prioritised by real demand
 * and bounded by the same per-miss recheck window so quota is respected.
 *
 * No-op when: YouTube isn't configured, the anime already has a trailer, or it
 * was checked within `recheckDays`. On a hit it busts the cached detail so the
 * very next view serves the new trailer.
 */
export async function ensureTrailerForView(malId: number, recheckDays = 45): Promise<void> {
  if (!ytKey() || inFlight.has(malId)) return;
  const a = await prisma.anime.findUnique({
    where: { malId },
    select: { malId: true, title: true, titleEnglish: true, year: true, trailerYoutubeId: true, trailerCheckedAt: true },
  });
  if (!a || a.trailerYoutubeId) return; // already has one
  const recheckBefore = new Date(Date.now() - recheckDays * 24 * 60 * 60_000);
  if (a.trailerCheckedAt && a.trailerCheckedAt > recheckBefore) return; // checked recently → skip (quota)

  inFlight.add(malId);
  try {
    const id = await resolveTrailer(a).catch(() => null);
    await prisma.anime.update({
      where: { malId },
      data: { trailerCheckedAt: new Date(), ...(id ? { trailerYoutubeId: id } : {}) },
    });
    if (id) { cache.del(`anime:${malId}`); cache.delPattern("anime:slug:"); }
  } catch { /* best-effort */ } finally {
    inFlight.delete(malId);
  }
}
