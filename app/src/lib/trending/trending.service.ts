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
 * Decayed event velocity per anime over the window, with unique-user counts.
 * Unions the qualifying first-party signals (list activity, feed posts/activities,
 * reviews, threads) and weights each event by exp(-λ·ageHours). Bounded by the
 * window, so it never scans full history.
 */
async function gatherVelocities(): Promise<VelocityRow[]> {
  const lambda = lambdaPerHour();
  const windowDays = TREND.WINDOW_DAYS;

  // λ and window come from trusted constants (not user input) → safe to inline.
  const rows = await prisma.$queryRawUnsafe<Array<{ animeId: string; velocity: number; uniqueusers: bigint }>>(
    `
    WITH ev AS (
      SELECT "animeId" AS aid, "updatedAt" AS ts, "userId"  AS uid
        FROM "ListEntry" WHERE "updatedAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "linkedAnimeId" AS aid, "createdAt" AS ts, "authorId" AS uid
        FROM "Activity" WHERE "linkedAnimeId" IS NOT NULL AND "deletedAt" IS NULL
                          AND "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid
        FROM "Post" WHERE "animeId" IS NOT NULL AND "deletedAt" IS NULL
                      AND "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid
        FROM "Review" WHERE "createdAt" > now() - interval '${windowDays} days'
      UNION ALL
      SELECT "animeId" AS aid, "createdAt" AS ts, "authorId" AS uid
        FROM "Thread" WHERE "animeId" IS NOT NULL AND "createdAt" > now() - interval '${windowDays} days'
    )
    SELECT aid AS "animeId",
           SUM(exp(-${lambda} * EXTRACT(EPOCH FROM (now() - ts)) / 3600.0)) AS velocity,
           COUNT(DISTINCT uid) AS uniqueusers
      FROM ev
     WHERE aid IS NOT NULL
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

  // Anti-gaming floor: a title needs ≥ N distinct users to be eligible.
  const active = velocities.filter((v) => v.uniqueUsers >= TREND.MIN_UNIQUE_USERS);
  if (active.length === 0) return { scored: 0, durationMs: Date.now() - started };

  const velocityP95 = percentile(active.map((v) => v.velocity), 95);
  const weekday = now.getUTCDay(); // 0=Sun..6=Sat
  const ids = active.map((v) => v.animeId);

  const [states, boosts] = await Promise.all([
    prisma.trendingState.findMany({ where: { animeId: { in: ids } } }),
    getBoostFlags(ids),
  ]);
  const stateById = new Map(states.map((s) => [s.animeId, s]));

  // Compute + persist each title's step. Writes are batched per title (state +
  // score); the set is bounded by "active titles this tick", not the catalog.
  let scored = 0;
  const scoreByAnime = new Map<string, number>();

  for (const v of active) {
    const existing = stateById.get(v.animeId);
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

    const boost = boosts.get(v.animeId) ?? { airing: false, episodePulse: false };
    const { score, next } = stepTrending(prevState, {
      velocity: v.velocity,
      uniqueUsers: v.uniqueUsers,
      weekday,
      velocityP95,
      airing: boost.airing,
      episodePulse: boost.episodePulse,
    });

    scoreByAnime.set(v.animeId, score);
    await prisma.$transaction([
      prisma.trendingState.upsert({
        where: { animeId: v.animeId },
        create: { animeId: v.animeId, ...next, lastVel: v.velocity },
        update: { ...next, lastVel: v.velocity },
      }),
      prisma.anime.update({
        where: { id: v.animeId },
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
