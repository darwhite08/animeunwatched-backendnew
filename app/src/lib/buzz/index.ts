/**
 * Off-platform buzz orchestrator. Runs on a slow (hourly) cadence, candidate-
 * gated, and writes a normalized `externalBuzz` (0..1) per anime into
 * TrendingState — which the 20-min computeTrending pass then blends into the
 * score. This is how a title can trend on WEB activity (AniList community +
 * Wikipedia readership) even before our own users post about it.
 *
 * Candidate set (bounds external calls at 30k scale, per verified research):
 *   AniList trending titles  ∪  currently-airing  ∪  top recent on-platform
 * — never a per-title poll of the whole catalog.
 */
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { fetchAniListTrending } from "./anilistTrending";
import { fetchPageviewBuzz, resolveWikipediaArticle, type ResolvedWikiCandidate } from "./wikipediaPageviews";

/** Resolve up to this many new Wikipedia articles per run (bounds search calls). */
const MAX_RESOLVE_PER_RUN = 40;
const RESOLVE_SLEEP_MS = 320;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// AniList community signal is the more reliable / anime-specific one, so it
// outweighs the noisier Wikipedia title-matched signal.
const W_ANILIST = 0.65;
const W_WIKI = 0.35;

export async function collectBuzz(now = new Date()): Promise<{
  anilist: number;
  wikipedia: number;
  written: number;
  durationMs: number;
}> {
  const started = Date.now();

  // ── 1. AniList trending (exact malId mapping; the primary web signal) ──
  const anilist = env.TRENDING_ANILIST_ENABLED ? await fetchAniListTrending(3).catch(() => new Map<number, number>()) : new Map<number, number>();

  // ── 2. Build candidate set ──
  const airing = await prisma.anime.findMany({ where: { airing: true }, select: { malId: true } });
  const candidateMalIds = new Set<number>([...anilist.keys(), ...airing.map((a) => a.malId)]);
  if (candidateMalIds.size === 0) return { anilist: anilist.size, wikipedia: 0, written: 0, durationMs: Date.now() - started };

  const candidates = await prisma.anime.findMany({
    where: { malId: { in: [...candidateMalIds] } },
    select: { id: true, malId: true, title: true, titleEnglish: true, wikipediaTitle: true },
  });

  // ── 3. Wikipedia pageviews for the candidate set (general interest) ──
  // Order by AniList buzz so the per-run caps keep the highest-signal titles.
  let wikipedia = new Map<number, number>();
  if (env.TRENDING_WIKIPEDIA_ENABLED) {
    const ordered = [...candidates].sort((a, b) => (anilist.get(b.malId) ?? 0) - (anilist.get(a.malId) ?? 0));

    // 3a. Resolve+cache Wikipedia articles for titles we haven't resolved yet
    //     (null = unresolved). Bounded per run; result stored on the Anime row,
    //     so each title is resolved at most once ("" = no confident article).
    let resolved = 0;
    for (const c of ordered) {
      if (resolved >= MAX_RESOLVE_PER_RUN) break;
      if (c.wikipediaTitle !== null && c.wikipediaTitle !== undefined) continue;
      const article = await resolveWikipediaArticle(c.titleEnglish || c.title);
      await sleep(RESOLVE_SLEEP_MS);
      await prisma.anime.update({ where: { id: c.id }, data: { wikipediaTitle: article ?? "" } });
      c.wikipediaTitle = article ?? "";
      resolved++;
    }

    // 3b. Fetch pageviews for candidates with a resolved (non-empty) article.
    const wikiInput: ResolvedWikiCandidate[] = ordered
      .filter((c): c is typeof c & { wikipediaTitle: string } => !!c.wikipediaTitle)
      .map((c) => ({ malId: c.malId, article: c.wikipediaTitle }));
    wikipedia = await fetchPageviewBuzz(wikiInput).catch(() => new Map<number, number>());
  }

  // ── 4. Blend → write externalBuzz per candidate ──
  let written = 0;
  for (const c of candidates) {
    const a = anilist.get(c.malId) ?? 0;
    const w = wikipedia.get(c.malId) ?? 0;
    if (a === 0 && w === 0) continue;
    const buzz = Math.min(1, W_ANILIST * a + W_WIKI * w);
    await prisma.trendingState.upsert({
      where: { animeId: c.id },
      create: { animeId: c.id, externalBuzz: buzz, buzzAt: now },
      update: { externalBuzz: buzz, buzzAt: now },
    });
    written++;
  }

  // ── 5. Decay stale buzz (titles that fell off the feeds) toward 0 so they
  //      don't linger as "trending" forever. ──
  await prisma.trendingState.updateMany({
    where: { buzzAt: { lt: new Date(now.getTime() - 6 * 60 * 60_000) }, externalBuzz: { gt: 0.01 } },
    data: { externalBuzz: 0 },
  });

  return { anilist: anilist.size, wikipedia: wikipedia.size, written, durationMs: Date.now() - started };
}
