/**
 * Official-stream resolver for the Kaiveron "Watch" experience.
 *
 * COMPLIANCE: this ONLY surfaces full episodes uploaded by official anime
 * distributors that left embedding enabled (Muse Asia, Ani-One, Crunchyroll,
 * GundamInfo, etc.). It never proxies/rips streams and never strips YouTube
 * attribution — the frontend embeds the standard IFrame player. We additionally
 * require a full-episode duration so clips/openings/PVs don't masquerade as
 * episodes, and we surface the channel so the watch page can credit it.
 *
 * Results are cached in-memory (no DB migration → keeps off the private RDS) and
 * the YouTube quota is shared with the trailer worker, so this is best-effort.
 */
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { YouTubeQuotaError } from "./youtubeTrailer.service";

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const ytKey = (): string | undefined => process.env.YOUTUBE_API_KEY;

export function watchSourcesEnabled(): boolean {
  return !!ytKey();
}

export interface WatchSource {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  episode: number | null;   // parsed from the title when possible
  blockedRegions: string[]; // ISO country codes where embedding is blocked
  allowedRegions: string[]; // if present, ONLY these regions can play
}

// Muse Asia's standard licensed region set (SEA + South Asia, incl. India).
const MUSE_SEA = ["BD", "BN", "BT", "ID", "IN", "KH", "LA", "MM", "MY", "NP", "PK", "PH", "SG", "TH", "VN"];

/**
 * CURATED official sources — hand-verified official uploads keyed by malId.
 * These are returned ALWAYS (even when the YouTube quota is exhausted or the
 * search can't surface a region-locked upload), merged ahead of resolver hits.
 * Only add OFFICIAL, embeddable uploads here. Region info drives the client's
 * "watch elsewhere" fallback for out-of-region viewers.
 */
const CURATED: Record<number, Array<{
  videoId: string; episode: number; channel: string;
  allowedRegions?: string[]; blockedRegions?: string[];
}>> = {
  // I Was Reincarnated as the 7th Prince — S1 (Muse India, Hindi dub, IN-only)
  53516: [
    { videoId: "4k1YC2z5VOw", episode: 1, channel: "Muse India", allowedRegions: ["IN"] },
  ],
  // Mushoku Tensei: Jobless Reincarnation — S1 (Muse Asia, English sub, SEA + India)
  39535: [
    { videoId: "mKS67U6ZEWM", episode: 1, channel: "Muse Asia", allowedRegions: MUSE_SEA },
    { videoId: "Y4bP1PMvsag", episode: 2, channel: "Muse Asia", allowedRegions: MUSE_SEA },
    { videoId: "WqlyT_-kIGM", episode: 3, channel: "Muse Asia", allowedRegions: MUSE_SEA },
  ],
};

/** malIds that have at least one hand-curated official source ("wired"). The
 *  /watch hub shows ONLY these so every banner/card actually plays. */
export function wiredMalIds(): number[] {
  return Object.keys(CURATED).map(Number);
}

function curatedFor(malId: number): WatchSource[] {
  return (CURATED[malId] ?? []).map((c) => ({
    videoId: c.videoId,
    title: `Episode ${c.episode}`,
    channel: c.channel,
    durationSec: 0,
    episode: c.episode,
    blockedRegions: c.blockedRegions ?? [],
    allowedRegions: c.allowedRegions ?? [],
  }));
}

function mergeSources(curated: WatchSource[], resolved: WatchSource[]): WatchSource[] {
  const seen = new Set(curated.map((s) => s.videoId));
  const merged = [...curated, ...resolved.filter((s) => !seen.has(s.videoId))];
  merged.sort((a, b) => {
    if (a.episode != null && b.episode != null) return a.episode - b.episode;
    if (a.episode != null) return -1;
    if (b.episode != null) return 1;
    return b.durationSec - a.durationSec;
  });
  return merged;
}

// Official anime distributors that legitimately upload FULL episodes with
// embedding on. Tighter than the trailer allowlist (which includes studios that
// only post PVs). Matched against the uploader's channel title.
const OFFICIAL_FULL_EPISODE_CHANNELS =
  /(muse\s*(asia|india|africa|indonesia|malaysia|communication)?|ani-?one|crunchyroll|gundam\s?info|medialink|netflix\s*anime|hidive|tms\s*entertainment|aniplex|toei\s*animation|bilibili)/i;

// Reject clips / non-episode uploads even from official channels.
const NON_EPISODE =
  /\b(trailer|teaser|\bpv\b|promo|preview|opening|ending|\bop\b|\bed\b|theme|music video|\bmv\b|clip|highlight|recap|digest|compilation|character|interview|reaction|behind the scenes)\b/i;

function parseEpisode(title: string): number | null {
  const m =
    title.match(/\b(?:episode|ep\.?|#)\s*0*(\d{1,3})\b/i) ||
    title.match(/\bE0*(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

function parseIsoDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

type SearchItem = { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } };

async function ytSearch(query: string, key: string): Promise<SearchItem[]> {
  const url =
    `${YT_BASE}/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=none` +
    `&maxResults=25&order=relevance&q=${encodeURIComponent(query)}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    // 429 = rate/quota limit; 403 quotaExceeded = daily cap. Either → throw so the
    // caller backs off and does NOT cache an empty (poisoned) result.
    if (res.status === 429) throw new YouTubeQuotaError();
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(body)) throw new YouTubeQuotaError();
    }
    return [];
  }
  return ((await res.json()) as { items?: SearchItem[] }).items ?? [];
}

/**
 * Resolve official, embeddable full episodes for an anime. Best-effort: returns
 * [] when nothing legitimate is found (frontend then deep-links out).
 */
export async function resolveWatchSources(malId: number): Promise<WatchSource[]> {
  const curated = curatedFor(malId);
  const key = ytKey();
  if (!key) return curated;

  const cacheKey = `watch:${malId}`;
  const cached = cache.get<WatchSource[]>(cacheKey);
  if (cached) return cached;

  try {
    return await resolveFromYouTube(malId, key, curated, cacheKey);
  } catch (e) {
    // Quota exhausted → still serve curated (and DON'T cache, so the resolver
    // retries once quota returns). Other errors bubble up.
    if (e instanceof YouTubeQuotaError) return curated;
    throw e;
  }
}

async function resolveFromYouTube(
  malId: number, key: string, curated: WatchSource[], cacheKey: string,
): Promise<WatchSource[]> {
  const anime = await prisma.anime.findUnique({
    where: { malId },
    select: { title: true, titleEnglish: true },
  });
  if (!anime) return curated;
  const name = anime.titleEnglish || anime.title;

  // Search both phrasings; dedupe by videoId.
  const items: SearchItem[] = [];
  for (const q of [`${name} full episode english sub`, `${name} episode`]) {
    items.push(...(await ytSearch(q, key)));
  }

  const candidates = items
    .map((i) => ({ videoId: i.id?.videoId, title: i.snippet?.title ?? "", channel: i.snippet?.channelTitle ?? "" }))
    .filter((c): c is { videoId: string; title: string; channel: string } => !!c.videoId)
    .filter((c) => OFFICIAL_FULL_EPISODE_CHANNELS.test(c.channel))
    .filter((c) => !NON_EPISODE.test(c.title));

  // Dedupe
  const byId = new Map(candidates.map((c) => [c.videoId, c]));
  const ids = [...byId.keys()].slice(0, 50);
  if (!ids.length) { const m = mergeSources(curated, []); cache.set(cacheKey, m, 6 * 60 * 60_000); return m; }

  // Enrich with duration + embeddable + region restriction (videos.list).
  const vUrl = `${YT_BASE}/videos?part=contentDetails,status&id=${ids.join(",")}&key=${key}`;
  const vRes = await fetch(vUrl);
  if (!vRes.ok) {
    if (vRes.status === 429) throw new YouTubeQuotaError();
    if (vRes.status === 403) {
      const body = await vRes.text().catch(() => "");
      if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(body)) throw new YouTubeQuotaError();
    }
    return mergeSources(curated, []);
  }
  const vData = (await vRes.json()) as {
    items?: Array<{
      id: string;
      contentDetails?: { duration?: string; regionRestriction?: { allowed?: string[]; blocked?: string[] } };
      status?: { embeddable?: boolean; privacyStatus?: string };
    }>;
  };

  const sources: WatchSource[] = [];
  for (const v of vData.items ?? []) {
    const c = byId.get(v.id);
    if (!c) continue;
    if (v.status?.embeddable === false) continue;
    if (v.status?.privacyStatus === "private") continue;
    const durationSec = parseIsoDuration(v.contentDetails?.duration ?? "");
    if (durationSec < 600) continue; // full episodes only (≥10 min) — drops clips/OP/ED
    sources.push({
      videoId: v.id,
      title: c.title,
      channel: c.channel,
      durationSec,
      episode: parseEpisode(c.title),
      blockedRegions: v.contentDetails?.regionRestriction?.blocked ?? [],
      allowedRegions: v.contentDetails?.regionRestriction?.allowed ?? [],
    });
  }

  // Merge curated (always first) with resolver hits, dedupe + sort by episode.
  const merged = mergeSources(curated, sources);
  cache.set(cacheKey, merged, 6 * 60 * 60_000);
  return merged;
}
