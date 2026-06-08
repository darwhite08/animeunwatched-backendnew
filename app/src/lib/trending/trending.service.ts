/**
 * Trending compute service — the I/O around trendingMath.ts.
 *
 * One pass per tick (cadence in jobs/index.ts):
 *   1. gather decayed event velocity per anime (one bounded windowed SQL aggregate)
 *   2. for each active title, run the O(1) streaming step (deseasonalize → robust-z
 *      → NEWMA → smooth), persisting only a handful of floats (TrendingState)
 *   3. write trendingScore back + dense-rank
 *
 * No history rescan, no Redis. Cost ≈ a few indexed window aggregates + O(active) floats.
 */
import { prisma } from "../../config/prisma";
import {
  TREND,
  initialTrendingState,
  lambdaPerHour,
  percentile,
  stepTrending,
  type TrendingStateLike,
} from "./trendingMath";

interface VelocityRow {
  animeId: string;
  velocity: number;
  uniqueUsers: number;
}

/**
 * Per-user-capped, signal-type-weighted decayed velocity per anime.
 *
 * Improvements over a naive event count (research-grounded anti-gaming/quality):
 *  - each event is weighted by SIGNAL TYPE (review ≫ post ≫ list-add) — effort/intent.
 *  - each USER's total weighted contribution to a title is CAPPED, so a handful of
 *    superfans/bots can't inflate it; velocity becomes "weighted breadth" (how many
 *    distinct people, lightly scaled by effort) not "depth" (how many times one person).
 *  - exp(-λ·ageHours) recency decay throughout. Bounded window → no full-history scan.
 */
async function gatherVelocities(): Promise<VelocityRow[]> {
  const lambda = lambdaPerHour();
  const windowDays = TREND.WINDOW_DAYS;
  const cap = TREND.USER_CONTRIB_CAP;
  const w = TREND.W_SIGNAL;

  // λ, window, weights, cap are trusted constants (not user input) → safe to inline.
  const rows = await prisma.$queryRawUnsafe<Array<{ animeId: string; velocity: number; uniqueusers: bigint }>>(
    `
    WITH ev AS (
      SELECT "animeId" AS aid, "updatedAt" AS ts, "userId"  AS uid, ${w.listEntry}::float AS sw
        FROM "ListEntry" WHERE "updatedAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "linkedAnimeId" AS aid, "createdAt" AS ts, "authorId" AS uid, ${w.activity}::float
        FROM "Activity" WHERE "linkedAnimeId" IS NOT NULL AND "deletedAt" IS NULL
                          AND "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid, ${w.post}::float
        FROM "Post" WHERE "animeId" IS NOT NULL AND "deletedAt" IS NULL
                      AND "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid, ${w.review}::float
        FROM "Review" WHERE "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid, ${w.thread}::float
        FROM "Thread" WHERE "animeId" IS NOT NULL AND "createdAt" > now() - interval '${windowDays} days'
    ),
    per_user AS (
      SELECT aid, uid,
             LEAST(${cap}::float, SUM(sw * exp(-${lambda} * EXTRACT(EPOCH FROM (now() - ts)) / 3600.0))) AS contrib
        FROM ev
       WHERE aid IS NOT NULL
       GROUP BY aid, uid
    )
    SELECT aid AS "animeId",
           SUM(contrib)   AS velocity,
           COUNT(*)       AS uniqueusers
      FROM per_user
     GROUP BY aid
    `,
  );

  return rows.map((r) => ({
    animeId: r.animeId,
    velocity: Number(r.velocity) || 0,
    uniqueUsers: Number(r.uniqueusers) || 0,
  }));
}

/** Anime currently airing / with a recent episode pulse, for the small boosts. */
async function getBoostFlags(animeIds: string[]): Promise<Map<string, { airing: boolean; episodePulse: boolean }>> {
  if (animeIds.length === 0) return new Map();
  const since = new Date(Date.now() - TREND.HALF_LIFE_H * 3_600_000);
  const [airingRows, pulseRows] = await Promise.all([
    prisma.anime.findMany({ where: { id: { in: animeIds }, airing: true }, select: { id: true } }),
    prisma.episode.findMany({
      where: { animeId: { in: animeIds }, aired: { gt: since } },
      select: { animeId: true },
      distinct: ["animeId"],
    }),
  ]);
  const map = new Map<string, { airing: boolean; episodePulse: boolean }>();
  for (const id of animeIds) map.set(id, { airing: false, episodePulse: false });
  for (const a of airingRows) map.get(a.id)!.airing = true;
  for (const e of pulseRows) map.get(e.animeId)!.episodePulse = true;
  return map;
}

/**
 * Recompute trending for all currently-active titles. Idempotent; safe to run
 * on any cadence. Titles with no recent activity decay out naturally (their
 * velocity is absent, so they aren't re-scored and keep their last — lower — score).
 */
export async function computeTrending(now = new Date()): Promise<{ scored: number; durationMs: number }> {
  const started = Date.now();
  const velocities = await gatherVelocities();
  const velocityByAnime = new Map(velocities.map((v) => [v.animeId, v]));

  // Candidate set = on-platform-active titles ∪ titles with off-platform web
  // buzz (so a show trending on AniList/Wikipedia surfaces even with no local
  // posts yet). Eligibility: enough distinct users OR enough web buzz.
  const buzzStates = await prisma.trendingState.findMany({
    where: { externalBuzz: { gte: TREND.MIN_EXTERNAL_BUZZ } },
    select: { animeId: true, externalBuzz: true },
  });
  const buzzById = new Map(buzzStates.map((b) => [b.animeId, b.externalBuzz]));

  const candidateIds = new Set<string>();
  for (const v of velocities) if (v.uniqueUsers >= TREND.MIN_UNIQUE_USERS) candidateIds.add(v.animeId);
  for (const b of buzzStates) candidateIds.add(b.animeId);
  if (candidateIds.size === 0) return { scored: 0, durationMs: Date.now() - started };

  const velocityP95 = percentile(velocities.map((v) => v.velocity), 95) || 1;
  const weekday = now.getUTCDay(); // 0=Sun..6=Sat
  const ids = [...candidateIds];

  const [states, boosts] = await Promise.all([
    prisma.trendingState.findMany({ where: { animeId: { in: ids } } }),
    getBoostFlags(ids),
  ]);
  const stateById = new Map(states.map((s) => [s.animeId, s]));

  // Compute + persist each candidate's step. Writes are batched per title;
  // the set is bounded by "candidates this tick", not the catalog.
  let scored = 0;
  const scoreByAnime = new Map<string, number>();

  for (const animeId of ids) {
    const v = velocityByAnime.get(animeId);
    const existing = stateById.get(animeId);
    const prevState: TrendingStateLike = existing
      ? {
          ewmaMean: existing.ewmaMean,
          ewmaDev: existing.ewmaDev,
          newmaFast: existing.newmaFast,
          newmaSlow: existing.newmaSlow,
          seasonal: (existing.seasonal as number[]) ?? [0, 0, 0, 0, 0, 0, 0],
          prevScore: existing.prevScore,
          samples: existing.samples,
        }
      : initialTrendingState();

    const boost = boosts.get(animeId) ?? { airing: false, episodePulse: false };
    const velocity = v?.velocity ?? 0;
    const { score, next, components } = stepTrending(prevState, {
      velocity,
      uniqueUsers: v?.uniqueUsers ?? 0,
      weekday,
      velocityP95,
      externalBuzz: buzzById.get(animeId) ?? existing?.externalBuzz ?? 0,
      airing: boost.airing,
      episodePulse: boost.episodePulse,
    });

    scoreByAnime.set(animeId, score);
    const componentsJson = {
      ...components,
      onPlatform: components.burst + components.magnitude + components.newma,
      uniqueUsers: v?.uniqueUsers ?? 0,
      airing: boost.airing,
    };
    await prisma.$transaction([
      prisma.trendingState.upsert({
        where: { animeId },
        create: { animeId, ...next, lastVel: velocity, components: componentsJson },
        update: { ...next, lastVel: velocity, components: componentsJson },
      }),
      prisma.anime.update({
        where: { id: animeId },
        data: { trendingScore: score, trendingUpdatedAt: now },
      }),
    ]);
    scored++;
  }

  // Dense-rank the freshly-scored titles (1 = hottest). Others keep null rank.
  const ranked = [...scoreByAnime.entries()].sort((a, b) => b[1] - a[1]);
  await prisma.$transaction(
    ranked.map(([animeId], i) =>
      prisma.anime.update({ where: { id: animeId }, data: { trendingRank: i + 1 } }),
    ),
  );

  return { scored, durationMs: Date.now() - started };
}
