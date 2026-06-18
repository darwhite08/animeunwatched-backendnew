import { prisma } from "../../config/prisma";
import { Prisma } from "../../generated/prisma/client";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { createNotification, NotificationType } from "../../lib/notify";
import { updateStreak } from "../../lib/streak";
import { auditDelete } from "../../lib/audit";
import { cache } from "../../lib/cache";
import { rankForYou, type RankableActivity, type ViewerContext } from "../../lib/feedRanking";
import {
  broadcastPostCreated, broadcastPostLiked, broadcastPostUnliked,
  broadcastAdminPostCreated, broadcastAdminPostDeleted,
  broadcastPostCommented, broadcastPostDeleted, broadcastPostComment,
} from "../../realtime/broadcast";
import type { CreatePostDto } from "./posts.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const postInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      verifiedKind: true, communityLead: true,
    },
  },
  anime: {
    select: {
      id: true,
      malId: true,
      title: true,
      imageUrl: true,
    },
  },
  _count: {
    select: { likes: true, comments: true },
  },
} as const;

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

export interface LikePreviewUser { username: string; displayName: string; avatarUrl: string | null }

/**
 * Attach `isLikedByMe` + `likePreview` (up to 3 most-recent likers, for the
 * Instagram-style overlapping-avatar row) to a page of posts. Both are batched
 * — one query each across all posts — so there's no N+1 in the feed.
 */
async function withLikeStatus<T extends { id: string }>(
  posts: T[], userId?: string,
): Promise<(T & { isLikedByMe: boolean; likePreview: LikePreviewUser[] })[]> {
  if (posts.length === 0) return [];
  const ids = posts.map(p => p.id);

  // Who *I* liked (only when authed).
  let likedSet = new Set<string>();
  if (userId) {
    const likes = await prisma.postLike.findMany({
      where: { userId, postId: { in: ids } }, select: { postId: true },
    });
    likedSet = new Set(likes.map((l: { postId: string }) => l.postId));
  }

  // Top-3 most-recent likers per post (single windowed query).
  const previewRows = await prisma.$queryRaw<Array<{ postId: string; username: string; displayName: string; avatarUrl: string | null }>>`
    SELECT t."postId", t.username, t."displayName", t."avatarUrl" FROM (
      SELECT pl."postId", u.username, u."displayName", u."avatarUrl",
             ROW_NUMBER() OVER (PARTITION BY pl."postId" ORDER BY pl."createdAt" DESC) AS rn
      FROM "PostLike" pl JOIN "User" u ON u.id = pl."userId"
      WHERE pl."postId" IN (${Prisma.join(ids)})
    ) t WHERE t.rn <= 3`;
  const previewByPost = new Map<string, LikePreviewUser[]>();
  for (const r of previewRows) {
    const arr = previewByPost.get(r.postId) ?? [];
    arr.push({ username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl });
    previewByPost.set(r.postId, arr);
  }

  return posts.map(p => ({
    ...p,
    isLikedByMe: likedSet.has(p.id),
    likePreview: previewByPost.get(p.id) ?? [],
  }));
}

// ─── getFeed ──────────────────────────────────────────────────────────────────

export async function getFeed(userId: string, cursor?: string, limit = 20) {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  const authorIds = [userId, ...follows.map((f: { followingId: string }) => f.followingId)];

  const posts = await prisma.post.findMany({
    where: {
      authorId: { in: authorIds },
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: postInclude,
  });

  const hasMore = posts.length > limit;
  const slice = hasMore ? posts.slice(0, limit) : posts;
  const data = await withLikeStatus(slice, userId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getDiscover ──────────────────────────────────────────────────────────────

export async function getDiscover(userId?: string, cursor?: string, limit = 20) {
  const posts = await prisma.post.findMany({
    where: {
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: postInclude,
  });

  const hasMore = posts.length > limit;
  const slice = hasMore ? posts.slice(0, limit) : posts;
  const data = await withLikeStatus(slice, userId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getTrending (algorithm-ranked feed) ─────────────────────────────────────
//
// Score per post:
//
//      (W_LIKE·likes + W_COMMENT·comments + 0.5) ^ ENGAGEMENT_EXP
//   ────────────────────────────────────────────────────────────────
//                  (age_hours + OFFSET_HOURS) ^ GRAVITY
//
// Hacker-News-style: sublinear engagement (so the first 10 likes matter more
// than the next 100) divided by superlinear age decay (so every post is
// guaranteed to fade). Comments outweigh likes 3× — effort-weighted, per X's
// open-sourced HeavyRanker which prices a reply ~27× a favorite and
// Instagram's emphasis on saves/comments over taps.
//
// Personalization (when userId present): 1.3× multiplier if the viewer
// follows the author (X-style 50/50 in-network/out-of-network mix; we lean
// in-network without dominating it).
//
// Diversity: post-ranking pass caps each author at MAX_PER_AUTHOR slots in
// the final result, so one prolific poster can't carpet-bomb the feed.
//
// Base scores (no personalization) are cached for 60s and shared across
// users — personalization is layered in-memory per request, so caching
// works even though personalization differs per user.
//
// Tuning levers (most likely to want changing first):
//   - GRAVITY: ↑ = newer wins more,    ↓ = old viral posts linger
//   - W_COMMENT: how much a comment outweighs a like
//   - FOLLOW_BOOST: how much in-network beats out-of-network
//   - MAX_PER_AUTHOR: lower for more diversity, higher for hero accounts
//
// Inspired by: HN gravity formula, Reddit hot.py, Twitter/X open-sourced
// algorithm (the-algorithm + the-algorithm-ml HeavyRanker weights),
// Instagram four-signals (Mosseri 2023), TikTok Monolith.

export const TRENDING_CONFIG = {
  // Base engagement-vs-age formula (HN-style, see getTrending docstring)
  GRAVITY:             1.8,
  ENGAGEMENT_EXPONENT: 0.8,
  OFFSET_HOURS:        2.0,
  W_LIKE:              1.0,
  W_COMMENT:           3.0,
  WINDOW_DAYS:         7,

  // Personalization multipliers (applied in JS post-fetch so the SQL cache
  // can stay viewer-independent).
  FOLLOW_BOOST:        1.3,   // viewer follows author
  WATCHLIST_BOOST:     1.25,  // post's anime is in viewer's watchlist
  RATED_HIGH_BOOST:    1.4,   // viewer rated this anime ≥ 8/10
  AUTHOR_AFFINITY_PER_LIKE: 0.05, // +5% per past like of this author (cap 1.5×)
  AUTHOR_AFFINITY_CAP: 1.5,

  // Negative signals — research-backed: report on X = −369 vs favorite +0.5.
  // A single Hide drops the post entirely; 3+ hides of the same author
  // applies a strong soft-block to that author's other posts for that viewer.
  AUTHOR_HIDE_THRESHOLD: 3,
  AUTHOR_HIDE_PENALTY:   0.2,  // ×0.2 — almost-but-not-quite invisible

  // Cold-start freshness bonus — additive, decays linearly to 0 at 24h.
  // Lets a brand-new post with 0 engagement still appear above an
  // 18-hour-old post with 1 like.
  FRESHNESS_BONUS_PEAK:  0.5,
  FRESHNESS_DECAY_HOURS: 24,

  // Author quality (light influence: 0.85× to 1.15× over the rep range)
  AUTHOR_REP_MIN_MULT: 0.85,
  AUTHOR_REP_MAX_MULT: 1.15,
  AUTHOR_REP_SOFTCAP:  1000,  // reputation above this stops increasing the mult

  // Diversity + caching
  MAX_PER_AUTHOR:      2,
  CACHE_TTL_MS:        60_000,
} as const

/**
 * Pure author-quality multiplier from raw reputation. Logarithmic so a
 * 1000-rep user isn't 100× a 10-rep user — capped at AUTHOR_REP_MAX_MULT.
 *
 * Exported for unit testing.
 */
export function authorQualityMultiplier(reputation: number): number {
  const { AUTHOR_REP_MIN_MULT: lo, AUTHOR_REP_MAX_MULT: hi, AUTHOR_REP_SOFTCAP: cap } = TRENDING_CONFIG
  const r = Math.max(0, reputation)
  // log10 family — softly maps [0, cap] → [0, 1]
  const norm = Math.min(1, Math.log10(r + 1) / Math.log10(cap + 1))
  return lo + (hi - lo) * norm
}

/** Linearly-decaying freshness bonus, peaking at FRESHNESS_BONUS_PEAK at age=0. */
export function freshnessBonus(ageHours: number): number {
  const { FRESHNESS_BONUS_PEAK: peak, FRESHNESS_DECAY_HOURS: span } = TRENDING_CONFIG
  if (ageHours <= 0) return peak
  if (ageHours >= span) return 0
  return peak * (1 - ageHours / span)
}

type ScoredRow = {
  id:              string
  authorId:        string
  animeId:         string | null
  authorReputation: number
  ageHours:        number
  baseScore:       number   // already includes manualBoost × shadowPenalty
}

export interface PersonalizationInputs {
  followedAuthors:    Set<string>
  hiddenPostIds:      Set<string>
  authorHideCounts:   Map<string, number>
  watchlistAnimeIds:  Set<string>
  highlyRatedAnimeIds: Set<string>
  authorLikeCounts:   Map<string, number>
}

/**
 * Final per-viewer score given the cached base row + personalization inputs.
 * Pure — exported for unit testing the math in isolation from Prisma.
 */
export function personalizedScore(row: ScoredRow, p: PersonalizationInputs): number {
  if (p.hiddenPostIds.has(row.id)) return -Infinity  // hard-hide

  let score = row.baseScore

  // Author quality (light multiplier, log-scaled)
  score *= authorQualityMultiplier(row.authorReputation)

  // In-network: viewer follows author
  if (p.followedAuthors.has(row.authorId)) {
    score *= TRENDING_CONFIG.FOLLOW_BOOST
  }

  // Author affinity: more likes you've given this author → higher score
  const pastLikes = p.authorLikeCounts.get(row.authorId) ?? 0
  if (pastLikes > 0) {
    const mult = Math.min(
      TRENDING_CONFIG.AUTHOR_AFFINITY_CAP,
      1 + pastLikes * TRENDING_CONFIG.AUTHOR_AFFINITY_PER_LIKE,
    )
    score *= mult
  }

  // Anime affinity: post about an anime the viewer cares about
  if (row.animeId) {
    if (p.highlyRatedAnimeIds.has(row.animeId)) {
      score *= TRENDING_CONFIG.RATED_HIGH_BOOST
    } else if (p.watchlistAnimeIds.has(row.animeId)) {
      score *= TRENDING_CONFIG.WATCHLIST_BOOST
    }
  }

  // Author-level soft-block: hidden too many → strongly demote remaining
  const hidesFromAuthor = p.authorHideCounts.get(row.authorId) ?? 0
  if (hidesFromAuthor >= TRENDING_CONFIG.AUTHOR_HIDE_THRESHOLD) {
    score *= TRENDING_CONFIG.AUTHOR_HIDE_PENALTY
  }

  // Cold-start freshness bonus (additive)
  score += freshnessBonus(row.ageHours)

  return score
}

/** Apply per-author diversity cap to a score-sorted list. */
export function applyDiversityCap<T extends { authorId: string }>(
  scored: T[],
  limit: number,
  maxPerAuthor: number = TRENDING_CONFIG.MAX_PER_AUTHOR,
): T[] {
  const seen = new Map<string, number>()
  const out: T[] = []
  for (const s of scored) {
    const n = seen.get(s.authorId) ?? 0
    if (n < maxPerAuthor) {
      out.push(s)
      seen.set(s.authorId, n + 1)
    }
    if (out.length >= limit) break
  }
  return out
}

/**
 * Algorithm-ranked trending feed.
 *
 * Layered scoring (see TRENDING_CONFIG for tuning constants):
 *
 *   1. BASE (cached SQL — viewer-independent)
 *      Hacker-News-style:
 *          (W_LIKE·likes + W_COMMENT·comments + 0.5)^0.8
 *        ──────────────────────────────────────────────── × manualBoost × shadowPenalty
 *                  (age_hours + 2)^1.8
 *
 *   2. PERSONALIZATION (per-request JS — see personalizedScore):
 *      × authorQualityMultiplier(reputation)    — light log-scaled quality
 *      × FOLLOW_BOOST if follows author
 *      × (1 + AUTHOR_AFFINITY_PER_LIKE · pastLikes)  — capped
 *      × WATCHLIST_BOOST / RATED_HIGH_BOOST if anime overlap
 *      × AUTHOR_HIDE_PENALTY if viewer has hidden ≥3 from this author
 *      + freshnessBonus(age) for cold-start
 *      = -Infinity if viewer has hidden THIS post
 *
 *   3. DIVERSITY (post-ranking): cap per-author at MAX_PER_AUTHOR.
 *
 * Step 1 cached 60s and shared across all viewers. Step 2 runs in-memory
 * per request, so caching still helps under load even though each viewer
 * sees a different ordering.
 */
export async function getTrending(userId?: string, limit = 20) {
  // Step 1: base scores — viewer-independent, cached.
  const baseCacheKey = `posts:trending:base:${limit}`
  let baseRows = cache.get<ScoredRow[]>(baseCacheKey)

  if (!baseRows) {
    const overFetch = Math.max(limit * 4, 80)
    const rows = await prisma.$queryRaw<Array<{
      id:               string
      authorId:         string
      animeId:          string | null
      authorReputation: number
      ageHours:         number
      score:            number
    }>>`
      SELECT
        p.id,
        p."authorId",
        p."animeId",
        u.reputation AS "authorReputation",
        EXTRACT(EPOCH FROM (NOW() - p."createdAt")) / 3600.0 AS "ageHours",
        (
          POWER(
            GREATEST(
              COUNT(DISTINCT pl."userId") * ${TRENDING_CONFIG.W_LIKE}::float +
              COUNT(DISTINCT pc.id)       * ${TRENDING_CONFIG.W_COMMENT}::float,
              0.0
            ) + 0.5,
            ${TRENDING_CONFIG.ENGAGEMENT_EXPONENT}::float
          ) / POWER(
            EXTRACT(EPOCH FROM (NOW() - p."createdAt")) / 3600.0
              + ${TRENDING_CONFIG.OFFSET_HOURS}::float,
            ${TRENDING_CONFIG.GRAVITY}::float
          )
        ) * p."manualBoost" * p."shadowPenalty" AS score
      FROM "Post" p
      JOIN "User" u                ON u.id = p."authorId"
      LEFT JOIN "PostLike"    pl  ON pl."postId" = p.id
      LEFT JOIN "PostComment" pc  ON pc."postId" = p.id
      WHERE p."deletedAt" IS NULL
        AND p."createdAt" > NOW()
          - (${TRENDING_CONFIG.WINDOW_DAYS} || ' days')::interval
      GROUP BY p.id, p."authorId", p."animeId", p."manualBoost", p."shadowPenalty", u.reputation
      ORDER BY score DESC
      LIMIT ${overFetch}
    `
    baseRows = rows.map(r => ({
      id:               r.id,
      authorId:         r.authorId,
      animeId:          r.animeId,
      authorReputation: Number(r.authorReputation ?? 0),
      ageHours:         Number(r.ageHours),
      baseScore:        Number(r.score),
    }))
    cache.set(baseCacheKey, baseRows, TRENDING_CONFIG.CACHE_TTL_MS)
  }

  if (baseRows.length === 0) {
    return { data: [], meta: { algorithm: "trending-v2", count: 0, personalized: !!userId } }
  }

  // Step 2: fetch viewer-specific personalization inputs in parallel.
  let inputs: PersonalizationInputs = {
    followedAuthors:    new Set(),
    hiddenPostIds:      new Set(),
    authorHideCounts:   new Map(),
    watchlistAnimeIds:  new Set(),
    highlyRatedAnimeIds: new Set(),
    authorLikeCounts:   new Map(),
  }

  if (userId) {
    const candidateIds      = baseRows.map(r => r.id)
    const candidateAuthors  = [...new Set(baseRows.map(r => r.authorId))]
    const candidateAnimeIds = baseRows.map(r => r.animeId).filter((a): a is string => !!a)

    const [follows, hides, hideAuthorAgg, watchlist, pastLikesAgg] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: userId },
        select: { followingId: true },
      }),
      prisma.postHide.findMany({
        where: { userId, postId: { in: candidateIds } },
        select: { postId: true },
      }),
      // Total hides per author (across ALL posts, not just current candidates)
      // — that's how author-level soft-blocks accumulate.
      prisma.postHide.findMany({
        where: { userId, post: { authorId: { in: candidateAuthors } } },
        select: { post: { select: { authorId: true } } },
      }),
      prisma.listEntry.findMany({
        where: { userId, animeId: { in: candidateAnimeIds } },
        select: { animeId: true, score: true },
      }),
      // Past likes given by viewer to candidates' authors — author affinity.
      prisma.postLike.findMany({
        where: { userId, post: { authorId: { in: candidateAuthors } } },
        select: { post: { select: { authorId: true } } },
      }),
    ])

    inputs.followedAuthors = new Set(follows.map(f => f.followingId))
    inputs.hiddenPostIds   = new Set(hides.map(h => h.postId))

    for (const w of watchlist) {
      inputs.watchlistAnimeIds.add(w.animeId)
      if ((w.score ?? 0) >= 8) inputs.highlyRatedAnimeIds.add(w.animeId)
    }
    for (const h of hideAuthorAgg) {
      const a = h.post.authorId
      inputs.authorHideCounts.set(a, (inputs.authorHideCounts.get(a) ?? 0) + 1)
    }
    for (const l of pastLikesAgg) {
      const a = l.post.authorId
      inputs.authorLikeCounts.set(a, (inputs.authorLikeCounts.get(a) ?? 0) + 1)
    }
  }

  // Step 3: score per viewer + filter hard-hidden posts.
  const scored = baseRows
    .map(r => ({ row: r, score: personalizedScore(r, inputs) }))
    .filter(s => Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score)
    .map(s => s.row)

  // Step 4: diversity cap.
  const diversified = applyDiversityCap(scored, limit)
  if (diversified.length === 0) {
    return { data: [], meta: { algorithm: "trending-v2", count: 0, personalized: !!userId } }
  }

  // Step 5: hydrate full post shape, preserve ranked order.
  const ids = diversified.map(d => d.id)
  const posts = await prisma.post.findMany({
    where:   { id: { in: ids } },
    include: postInclude,
  })
  const byId = new Map(posts.map(p => [p.id, p]))
  const ordered = ids
    .map(id => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const data = await withLikeStatus(ordered, userId)

  return {
    data,
    meta: {
      algorithm:    "trending-v2",
      count:        data.length,
      personalized: !!userId,
    },
  }
}

// ─── "For You" feed (X-style pipeline, runnable on our stack) ────────────────
//
// Faithful adaptation of X's "For You" recommendation model
// (github.com/xai-org/x-algorithm). Same pipeline shape — only the ranker
// differs: X scores candidates with a Grok-1 transformer that predicts ~15
// engagement probabilities and sums them by weight; we don't run model serving,
// so we substitute a transparent weighted score over OBSERVED engagement +
// recency + interest/affinity (lib/feedRanking.ts, weights in config/ranking.ts).
//
//   1. Query hydration   — follows, blocks, hides, list (taste/progress), past likes
//   2. Candidate sourcing — in-network (followed, recent)  ⨁  out-of-network
//                           (top global engagement) — X's Thunder ⨁ Phoenix mix
//   3. Enrichment         — like/comment counts, author, anime, recency
//   4. Pre-scoring filters — banned/shadow-banned/blocked authors, hidden posts, age
//   5. Scoring            — weighted engagement velocity + recency + author affinity
//                           + topic (anime taste) match − spoiler/quality penalties
//   6. Selection          — sort → series diversify → per-author cap → top-K
//   7. Post-selection     — hydrate + like status + "why am I seeing this" reason
const FORYOU_CONFIG = {
  WINDOW_DAYS:       7,    // only posts younger than this are candidates
  IN_NETWORK_FETCH:  60,   // recent followed-author posts to consider
  OUT_NETWORK_FETCH: 80,   // top global-engagement posts (discovery)
  OVERFETCH_MULT:    5,
  MAX_PER_AUTHOR:    2,     // author-diversity cap (X does author diversity)
  FOLLOW_AFFINITY:   0.6,   // baseline author affinity for in-network authors
  LIKE_AFFINITY_STEP:0.25,  // +per past like you've given that author (affinity ≤ 1)
} as const

export async function getForYou(userId: string, limit = 20) {
  const since = new Date(Date.now() - FORYOU_CONFIG.WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // 2) CANDIDATE SOURCING — in-network (followed) ⨁ out-of-network (engagement).
  const follows = await prisma.follow.findMany({
    where: { followerId: userId, status: "ACCEPTED" },
    select: { followingId: true },
  })
  const followedSet = new Set(follows.map(f => f.followingId))

  const [inNet, outNet] = await Promise.all([
    followedSet.size
      ? prisma.post.findMany({
          where: { authorId: { in: [...followedSet] }, deletedAt: null, createdAt: { gte: since } },
          orderBy: { createdAt: "desc" }, take: FORYOU_CONFIG.IN_NETWORK_FETCH, select: { id: true },
        })
      : Promise.resolve([] as { id: string }[]),
    prisma.post.findMany({
      where: { deletedAt: null, createdAt: { gte: since } },
      orderBy: [{ likes: { _count: "desc" } }, { createdAt: "desc" }],
      take: FORYOU_CONFIG.OUT_NETWORK_FETCH, select: { id: true },
    }),
  ])
  const candidateIds = [...new Set([...inNet.map(p => p.id), ...outNet.map(p => p.id)])]
  const emptyResult = { data: [] as unknown[], meta: { algorithm: "for-you-v1", count: 0, personalized: true } }
  if (candidateIds.length === 0) return emptyResult

  // 3) ENRICHMENT — engagement counts + author flags + recency, one query.
  const rows = await prisma.$queryRaw<Array<{
    id: string; authorId: string; animeId: string | null; createdAt: Date; content: string
    likeCount: number; commentCount: number; isBanned: boolean; isShadowBanned: boolean
  }>>`
    SELECT p.id, p."authorId", p."animeId", p."createdAt", p.content,
           COUNT(DISTINCT pl."userId")::int AS "likeCount",
           COUNT(DISTINCT pc.id)::int       AS "commentCount",
           u."isBanned", u."isShadowBanned"
    FROM "Post" p
    JOIN "User" u ON u.id = p."authorId"
    LEFT JOIN "PostLike"    pl ON pl."postId" = p.id
    LEFT JOIN "PostComment" pc ON pc."postId" = p.id
    WHERE p.id IN (${Prisma.join(candidateIds)}) AND p."deletedAt" IS NULL
    GROUP BY p.id, p."authorId", p."animeId", p."createdAt", p.content, u."isBanned", u."isShadowBanned"
  `

  // 1) QUERY HYDRATION — viewer signals (parallel).
  const candidateAuthors  = [...new Set(rows.map(r => r.authorId))]
  const candidateAnimeIds = rows.map(r => r.animeId).filter((a): a is string => !!a)
  const [blocks, hides, listEntries, pastLikes] = await Promise.all([
    prisma.userBlock.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.postHide.findMany({ where: { userId, postId: { in: candidateIds } }, select: { postId: true } }),
    prisma.listEntry.findMany({
      where: { userId, animeId: { in: candidateAnimeIds } },
      select: { animeId: true, score: true, episodesSeen: true },
    }),
    prisma.postLike.findMany({
      where: { userId, post: { authorId: { in: candidateAuthors } } },
      select: { post: { select: { authorId: true } } },
    }),
  ])

  const blocked = new Set(blocks.map(b => b.blockedId))
  const hidden  = new Set(hides.map(h => h.postId))
  const likesByAuthor = new Map<string, number>()
  for (const l of pastLikes) likesByAuthor.set(l.post.authorId, (likesByAuthor.get(l.post.authorId) ?? 0) + 1)

  // Build the X-style ViewerContext.
  const affinity = new Map<string, number>()
  for (const a of candidateAuthors) {
    let v = followedSet.has(a) ? FORYOU_CONFIG.FOLLOW_AFFINITY : 0
    v += (likesByAuthor.get(a) ?? 0) * FORYOU_CONFIG.LIKE_AFFINITY_STEP
    if (v > 0) affinity.set(a, Math.min(1, v))
  }
  const seriesAffinity = new Map<string, number>()
  const progress = new Map<string, number>()
  for (const e of listEntries) {
    seriesAffinity.set(e.animeId, (e.score ?? 0) >= 8 ? 1 : 0.6) // rated-high vs on-list taste
    progress.set(e.animeId, e.episodesSeen)
  }
  const viewer: ViewerContext = {
    affinity, seriesAffinity, progress,
    spoilerOptIn: new Set(), mutedKeywords: [], blocked,
  }

  // 4) PRE-SCORING FILTERS → candidate objects for the ranker.
  const candidates: RankableActivity[] = rows
    .filter(r => !r.isBanned && !r.isShadowBanned && !hidden.has(r.id) && !blocked.has(r.authorId))
    .map(r => ({
      id: r.id, authorId: r.authorId, body: r.content,
      linkedSeriesId: r.animeId, createdAt: r.createdAt,
      likeCount: Number(r.likeCount), replyCount: Number(r.commentCount),
      repostCount: 0, saveCount: 0, quoteCount: 0, // Posts have no reposts/saves/quotes
    }))
  if (candidates.length === 0) return emptyResult

  // 5+6) SCORE → series-diversify (rankForYou) → author-diversity cap → top-K.
  const overFetch = Math.max(limit * FORYOU_CONFIG.OVERFETCH_MULT, 60)
  const scored = rankForYou(viewer, candidates, overFetch)
  const reasonById = new Map(scored.map(s => [s.activity.id, s.dominantTerm]))
  const picked = applyDiversityCap(
    scored.map(s => ({ id: s.activity.id, authorId: s.activity.authorId })),
    limit,
    FORYOU_CONFIG.MAX_PER_AUTHOR,
  )
  const ids = picked.map(p => p.id)
  if (ids.length === 0) return emptyResult

  // 7) HYDRATE — preserve ranked order + attach like status + "why am I seeing this".
  const posts = await prisma.post.findMany({ where: { id: { in: ids } }, include: postInclude })
  const byId = new Map(posts.map(p => [p.id, p]))
  const ordered = ids.map(id => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
  const withLikes = await withLikeStatus(ordered, userId)
  const data = withLikes.map(p => ({ ...p, reason: reasonById.get(p.id) ?? "recency" }))

  return {
    data,
    meta: {
      algorithm: "for-you-v1",
      count: data.length,
      personalized: true,
      sources: { inNetwork: inNet.length, outOfNetwork: outNet.length },
    },
  }
}

// ─── Negative-signal API (Not Interested) ────────────────────────────────────

export async function hidePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) throw notFound("Post not found")
  await prisma.postHide.upsert({
    where:  { userId_postId: { userId, postId } },
    update: {},
    create: { userId, postId },
  })
  return { hidden: true }
}

export async function unhidePost(userId: string, postId: string) {
  await prisma.postHide.deleteMany({ where: { userId, postId } })
  return { hidden: false }
}

// ─── Admin manual-override API ───────────────────────────────────────────────

export async function setPostScoreOverride(
  postId: string,
  patch: { manualBoost?: number; shadowPenalty?: number },
) {
  // Light sanity — admin UI should clamp but defend in depth.
  const data: { manualBoost?: number; shadowPenalty?: number } = {}
  if (typeof patch.manualBoost === "number") {
    data.manualBoost = Math.max(0, Math.min(10, patch.manualBoost))
  }
  if (typeof patch.shadowPenalty === "number") {
    data.shadowPenalty = Math.max(0, Math.min(1, patch.shadowPenalty))
  }
  if (Object.keys(data).length === 0) return null
  const post = await prisma.post.update({
    where: { id: postId },
    data,
    select: { id: true, manualBoost: true, shadowPenalty: true },
  })
  // Invalidate the trending base cache so the change shows up immediately.
  cache.delPattern("posts:trending:base:")
  return post
}

// ─── getPost ──────────────────────────────────────────────────────────────────

export async function getPost(id: string, userId?: string) {
  const post = await prisma.post.findUnique({
    where: { id },
    include: postInclude,
  });

  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  let liked: boolean | undefined;
  if (userId) {
    const like = await prisma.postLike.findUnique({
      where: { userId_postId: { userId, postId: id } },
    });
    liked = like !== null;
  }

  const reactions = await postReactions(id, userId);
  return { post: { ...post, reactions }, liked };
}

// ─── reactions (emoji, reusing the polymorphic ThreadReaction table) ──────────

type PostReactionSummary = { emoji: string; count: number; reactedByMe: boolean };

async function postReactions(postId: string, userId?: string): Promise<PostReactionSummary[]> {
  const rows = await prisma.threadReaction.findMany({
    where: { targetId: postId },
    select: { emoji: true, userId: true },
  });
  const m = new Map<string, PostReactionSummary>();
  for (const r of rows) {
    const e = m.get(r.emoji) ?? { emoji: r.emoji, count: 0, reactedByMe: false };
    e.count += 1;
    if (userId && r.userId === userId) e.reactedByMe = true;
    m.set(r.emoji, e);
  }
  return [...m.values()];
}

/** Toggle an emoji reaction on a post. */
export async function reactToPost(postId: string, userId: string, emoji: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, deletedAt: true } });
  if (!post || post.deletedAt) throw notFound("Post not found");
  const existing = await prisma.threadReaction.findUnique({ where: { targetId_userId_emoji: { targetId: postId, userId, emoji } } });
  if (existing) await prisma.threadReaction.delete({ where: { id: existing.id } });
  else await prisma.threadReaction.create({ data: { targetId: postId, targetType: "post", userId, emoji } });
  return { reactions: await postReactions(postId, userId) };
}

// ─── createPost ───────────────────────────────────────────────────────────────

export async function createPost(authorId: string, dto: CreatePostDto) {
  // Accept a single imageUrl (legacy) or an imageUrls[] gallery. Persist the full
  // array AND mirror the first into imageUrl so older readers still render one.
  const images = (dto.imageUrls && dto.imageUrls.length ? dto.imageUrls : dto.imageUrl ? [dto.imageUrl] : []).slice(0, 10);
  const post = await prisma.post.create({
    data: {
      authorId,
      content: dto.content,
      ...(dto.animeId ? { animeId: dto.animeId } : {}),
      ...(images.length ? { imageUrl: images[0], imageUrls: images } : {}),
      // Author's gallery layout only matters for 2+ images; default grid.
      ...(images.length > 1 && dto.galleryLayout ? { galleryLayout: dto.galleryLayout } : {}),
    },
    include: postInclude,
  });
  addReputation(authorId, "post_created").catch(console.error);
  void updateStreak(authorId).catch(() => {});

  // Fire-and-forget: notify @mentioned users
  void (async () => {
    const mentionRegex = /\B@(\w+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(dto.content)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length === 0) return;

    const mentionedUsers = await prisma.user.findMany({
      where: { username: { in: mentions } },
      select: { id: true, username: true },
    });

    await Promise.all(
      mentionedUsers
        .filter((u: { id: string; username: string }) => u.id !== authorId)
        .map((u: { id: string; username: string }) =>
          createNotification({
            recipientId: u.id,
            type: NotificationType.MENTION,
            payload: {
              message: `${post.author?.displayName ?? post.author?.username ?? "Someone"} mentioned you in a post`,
              postId: post.id,
              content: dto.content.slice(0, 100),
              actorUsername: post.author?.username,
              actorDisplayName: post.author?.displayName,
              actorAvatarUrl: post.author?.avatarUrl ?? null,
              postImageUrl: post.imageUrl ?? null,
            },
          }).catch(console.error),
        ),
    );
  })().catch(console.error);

  // Realtime: broadcast the new post to all connected clients in the feed room
  broadcastPostCreated(post);
  broadcastAdminPostCreated();

  return { post };
}

// ─── deletePost ───────────────────────────────────────────────────────────────

export async function deletePost(id: string, userId: string, userRole: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const canEdit = post.authorId === userId || userRole === "MOD" || userRole === "ADMIN";
  if (!canEdit) throw forbidden("Not allowed to delete this post");

  await prisma.post.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  auditDelete("post_deleted", {
    actorId:    userId,
    targetType: "Post",
    targetId:   id,
    extra: post.authorId !== userId ? { byMod: true, originalAuthorId: post.authorId } : undefined,
  });

  broadcastPostDeleted(id);
  broadcastAdminPostDeleted(id, userId);
}

// ─── likePost ─────────────────────────────────────────────────────────────────

export async function likePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  // Check if like already exists before awarding reputation
  const existing = await prisma.postLike.findUnique({
    where: { userId_postId: { userId, postId } },
    select: { userId: true },
  });

  await prisma.postLike.upsert({
    where: { userId_postId: { userId, postId } },
    create: { userId, postId },
    update: {},
  });

  // Only award reputation for a new like, not a duplicate
  if (!existing) {
    addReputation(post.authorId, "post_liked").catch(console.error);
  }

  // Authoritative count from the DB — used by the response AND the broadcast,
  // so the client never has to guess.
  const count = await prisma.postLike.count({ where: { postId } });

  try {
    broadcastPostLiked(postId, post.authorId, count, userId);
  } catch { /* socket emission is best-effort */ }

  return { liked: true, count };
}

// ─── unlikePost ───────────────────────────────────────────────────────────────

export async function unlikePost(userId: string, postId: string) {
  await prisma.postLike.deleteMany({ where: { userId, postId } });
  const count = await prisma.postLike.count({ where: { postId } });
  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } });
    if (post) broadcastPostUnliked(postId, post.authorId, count);
  } catch { /* best-effort broadcast */ }
  return { liked: false, count };
}

// ─── Comment helpers ─────────────────────────────────────────────────────────

const COMMENT_AUTHOR_SELECT = {
  id: true, username: true, displayName: true, avatarUrl: true, verifiedKind: true, communityLead: true,
} as const;

async function attachCommentLikeStatus<T extends { id: string }>(comments: T[], userId?: string) {
  if (!userId || comments.length === 0) return comments.map(c => ({ ...c, isLikedByMe: false }));
  const likes = await prisma.postCommentLike.findMany({
    where: { userId, commentId: { in: comments.map(c => c.id) } },
    select: { commentId: true },
  });
  const set = new Set(likes.map((l: { commentId: string }) => l.commentId));
  return comments.map(c => ({ ...c, isLikedByMe: set.has(c.id) }));
}

// ─── getLikers ───────────────────────────────────────────────────────────────
// The people who liked a post (Instagram-style likes list). Most recent first,
// annotated with whether the viewer already follows each one (for follow CTAs).

const LIKER_SELECT = {
  id: true, username: true, slug: true, displayName: true, avatarUrl: true, verifiedKind: true, communityLead: true,
} as const;

export async function getLikers(postId: string, page = 1, limit = 30, viewerId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, deletedAt: true } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const { skip, take } = paginate(page, limit);
  const [rows, total] = await prisma.$transaction([
    prisma.postLike.findMany({
      where: { postId }, skip, take, orderBy: { createdAt: "desc" },
      select: { user: { select: LIKER_SELECT } },
    }),
    prisma.postLike.count({ where: { postId } }),
  ]);

  const ids = rows.map((r: { user: { id: string } }) => r.user.id);
  let followed = new Set<string>();
  if (viewerId && ids.length) {
    const f = await prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: ids }, status: "ACCEPTED" },
      select: { followingId: true },
    });
    followed = new Set(f.map((x: { followingId: string }) => x.followingId));
  }

  const data = rows.map((r: { user: { id: string } }) => ({
    ...r.user,
    isFollowedByMe: followed.has(r.user.id),
    isMe: r.user.id === viewerId,
  }));
  return { data, meta: meta(total, page, limit) };
}

// ─── getComments ─────────────────────────────────────────────────────────────
//
// Returns TOP-LEVEL comments (parentCommentId IS NULL) on a post, each with
// the FIRST FEW nested replies inline (thread-string preview). Deeper levels
// must be fetched via getCommentReplies.

const REPLIES_INLINE = 3;

export async function getComments(postId: string, page = 1, limit = 20, viewerId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const { skip, take } = paginate(page, limit);

  const [topLevel, total] = await prisma.$transaction([
    prisma.postComment.findMany({
      where: { postId, parentCommentId: null },
      skip,
      take,
      // Pinned comments float to the top (most-recently-pinned first), then chronological.
      orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
      include: {
        author:  { select: COMMENT_AUTHOR_SELECT },
        replies: {
          take: REPLIES_INLINE,
          orderBy: { createdAt: "asc" },
          include: { author: { select: COMMENT_AUTHOR_SELECT } },
        },
      },
    }),
    prisma.postComment.count({ where: { postId, parentCommentId: null } }),
  ]);

  // Attach isLikedByMe to BOTH top-level + inline replies
  const allIds = topLevel.flatMap(c => [c.id, ...c.replies.map(r => r.id)]);
  const likedSet = new Set<string>();
  if (viewerId && allIds.length > 0) {
    const likes = await prisma.postCommentLike.findMany({
      where: { userId: viewerId, commentId: { in: allIds } },
      select: { commentId: true },
    });
    for (const l of likes) likedSet.add(l.commentId);
  }
  // Which comments the POST AUTHOR liked → "❤ liked by author" badge.
  const authorLikedSet = new Set<string>();
  if (post.authorId && allIds.length > 0) {
    const al = await prisma.postCommentLike.findMany({
      where: { userId: post.authorId, commentId: { in: allIds } },
      select: { commentId: true },
    });
    for (const l of al) authorLikedSet.add(l.commentId);
  }
  const data = topLevel.map(c => ({
    ...c,
    isLikedByMe: likedSet.has(c.id),
    likedByAuthor: authorLikedSet.has(c.id),
    replies: c.replies.map(r => ({ ...r, isLikedByMe: likedSet.has(r.id), likedByAuthor: authorLikedSet.has(r.id) })),
  }));

  return { data, meta: meta(total, page, limit) };
}

// ─── getCommentReplies ───────────────────────────────────────────────────────
// Page-paginated replies for a single parent comment (used by "View N more").

export async function getCommentReplies(commentId: string, page = 1, limit = 20, viewerId?: string) {
  const parent = await prisma.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, post: { select: { authorId: true } } },
  });
  if (!parent) throw notFound("Comment not found");

  const { skip, take } = paginate(page, limit);
  const [rows, total] = await prisma.$transaction([
    prisma.postComment.findMany({
      where: { parentCommentId: commentId },
      skip, take,
      orderBy: { createdAt: "asc" },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
    }),
    prisma.postComment.count({ where: { parentCommentId: commentId } }),
  ]);
  const liked = await attachCommentLikeStatus(rows, viewerId);
  const authorId = parent.post.authorId;
  const authorLikedSet = new Set<string>();
  if (authorId && rows.length > 0) {
    const al = await prisma.postCommentLike.findMany({
      where: { userId: authorId, commentId: { in: rows.map((r: { id: string }) => r.id) } },
      select: { commentId: true },
    });
    for (const l of al) authorLikedSet.add(l.commentId);
  }
  const data = liked.map((c) => ({ ...c, likedByAuthor: authorLikedSet.has(c.id) }));
  return { data, meta: meta(total, page, limit) };
}

// ─── createComment ────────────────────────────────────────────────────────────

export async function createComment(postId: string, authorId: string, content: string, parentCommentId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  if (parentCommentId) {
    const parent = await prisma.postComment.findUnique({
      where: { id: parentCommentId },
      select: { postId: true },
    });
    if (!parent || parent.postId !== postId) throw notFound("Parent comment not found");
  }

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.postComment.create({
      data: {
        postId, authorId, content,
        parentCommentId: parentCommentId ?? null,
      },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
    });
    if (parentCommentId) {
      await tx.postComment.update({
        where: { id: parentCommentId },
        data:  { replyCount: { increment: 1 } },
      });
    }
    return created;
  });

  // Realtime: broadcast new top-level comment count (replies don't bump the
  // post's headline count — they live under their parent thread).
  try {
    if (!parentCommentId) {
      const comments = await prisma.postComment.count({ where: { postId, parentCommentId: null } });
      broadcastPostCommented(postId, post.authorId, comments);
    }
    broadcastPostComment(postId, comment);
  } catch { /* fire-and-forget */ }

  return { comment: { ...comment, isLikedByMe: false, likeCount: 0, replyCount: 0, replies: [] } };
}

// ─── like / unlike a comment ─────────────────────────────────────────────────

export async function likeComment(userId: string, commentId: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.postComment.findUnique({ where: { id: commentId }, select: { id: true } });
    if (!c) throw notFound("Comment not found");
    try {
      await tx.postCommentLike.create({ data: { userId, commentId } });
      await tx.postComment.update({
        where: { id: commentId },
        data:  { likeCount: { increment: 1 } },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return { ok: true, alreadyLiked: true };
      throw err;
    }
    return { ok: true };
  });
}

export async function unlikeComment(userId: string, commentId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.postCommentLike.findUnique({
      where: { userId_commentId: { userId, commentId } },
    });
    if (!existing) return { ok: true, alreadyUnliked: true };
    await tx.postCommentLike.delete({
      where: { userId_commentId: { userId, commentId } },
    });
    await tx.postComment.update({
      where: { id: commentId },
      data:  { likeCount: { decrement: 1 } },
    });
    return { ok: true };
  });
}

// ─── pin / unpin a comment ───────────────────────────────────────────────────
// Only the post's author (or an admin) may pin/unpin. Pinned comments float to
// the top of getComments via the pinnedAt ordering.

export async function setCommentPinned(userId: string, isAdmin: boolean, commentId: string, pinned: boolean) {
  const comment = await prisma.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, post: { select: { authorId: true } } },
  });
  if (!comment) throw notFound("Comment not found");
  if (!isAdmin && comment.post.authorId !== userId) {
    throw forbidden("Only the post author can pin comments");
  }
  await prisma.postComment.update({
    where: { id: commentId },
    data:  { pinnedAt: pinned ? new Date() : null },
  });
  return { ok: true, pinned };
}

// ─── delete a comment ────────────────────────────────────────────────────────
// The comment's author, the post's author, or an admin may delete. Replies +
// likes cascade via the schema's onDelete: Cascade relations.

export async function deletePostComment(userId: string, isAdmin: boolean, commentId: string) {
  const c = await prisma.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, parentCommentId: true, post: { select: { authorId: true } } },
  });
  if (!c) throw notFound("Comment not found");
  if (!isAdmin && c.authorId !== userId && c.post.authorId !== userId) {
    throw forbidden("You can't delete this comment");
  }
  await prisma.$transaction(async (tx) => {
    if (c.parentCommentId) {
      await tx.postComment.update({ where: { id: c.parentCommentId }, data: { replyCount: { decrement: 1 } } }).catch(() => {});
    }
    await tx.postComment.delete({ where: { id: commentId } });
  });
  return { ok: true };
}
