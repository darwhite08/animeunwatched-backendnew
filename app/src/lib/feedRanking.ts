/**
 * AnimeUnwatched — Feed ranking reference implementation
 * Pure, dependency-free functions. Import into your Express services / BullMQ workers.
 *
 *  - hotScore():        Reddit-style "Hot" for Global / Series / Trending feeds.
 *  - wilsonScore():     confidence sort for comments ("Best").
 *  - engagementWeight(): weighted engagement (replies/reposts > likes).
 *  - relevanceScore():  transparent "For You" scoring (no ML needed for V1).
 *  - diversifyBySeries(): post-rank diversification to avoid same-series runs.
 *
 *  All weights live in RANKING_CONFIG so you can tune from env without redeploying logic.
 */

// Weights live in src/config/ranking.ts so they can be overridden from env
// without redeploying. Re-exported here for compatibility with the reference
// implementation.
import { RANKING_CONFIG } from "../config/ranking";
export { RANKING_CONFIG };

export interface EngagementCounts {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  saveCount: number;
  quoteCount?: number;
}

/** Weighted engagement: a reply is worth more than a like. */
export function engagementWeight(c: EngagementCounts): number {
  const w = RANKING_CONFIG.weights;
  return (
    c.likeCount * w.like +
    c.replyCount * w.reply +
    c.repostCount * w.repost +
    c.saveCount * w.save +
    (c.quoteCount ?? 0) * w.quote
  );
}

/**
 * Reddit-style "Hot" score.
 * order = log10(max(|engagement|, 1)); plus a linear time term so early *velocity* wins.
 * Two posts with equal lifetime engagement: the newer one ranks higher.
 */
export function hotScore(c: EngagementCounts, createdAt: Date): number {
  const s = engagementWeight(c);
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  const seconds = Math.floor(createdAt.getTime() / 1000) - RANKING_CONFIG.epochSeconds;
  const score = order + (sign * seconds) / RANKING_CONFIG.hotDecaySeconds;
  return Number(score.toFixed(7));
}

/**
 * Wilson lower-bound confidence score for comment ranking ("Best").
 * A comment with 10↑/1↓ outranks 1↑/0↓ because there is more evidence it is good.
 * Submission time is irrelevant — solves "first comment wins forever".
 */
export function wilsonScore(up: number, down: number, z = RANKING_CONFIG.wilsonZ): number {
  const n = up + down;
  if (n === 0) return 0;
  const p = up / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (center - margin) / denom;
}

/** Exponential recency decay in [0,1]. */
export function recency(createdAt: Date, now = new Date()): number {
  const ageHours = (now.getTime() - createdAt.getTime()) / 3_600_000;
  const lambda = Math.LN2 / RANKING_CONFIG.recencyHalfLifeHours;
  return Math.exp(-lambda * Math.max(ageHours, 0));
}

/** Normalize a hot score into ~[0,1] for blending into relevance. Tune divisor to your data. */
export function normalizedHot(c: EngagementCounts, createdAt: Date, divisor = 10): number {
  return Math.min(Math.max(hotScore(c, createdAt) / divisor, 0), 1);
}

// ---------------------------- For You ----------------------------

export interface ViewerContext {
  /** authorId -> interaction strength in [0,1] (likes/replies you've given them, recency-weighted). */
  affinity: Map<string, number>;
  /** seriesId -> taste match in [0,1] (on your lists / genre overlap). */
  seriesAffinity: Map<string, number>;
  /** seriesId -> episodes/chapters watched (drives spoiler risk). */
  progress: Map<string, number>;
  /** seriesId set the viewer opted into spoilers for. */
  spoilerOptIn: Set<string>;
  /** lowercased muted keywords. */
  mutedKeywords: string[];
  /** userId set the viewer blocked. */
  blocked: Set<string>;
}

export interface RankableActivity extends EngagementCounts {
  id: string;
  authorId: string;
  body?: string | null;
  linkedSeriesId?: string | null;
  spoilerScopeSeriesId?: string | null;
  spoilerUpToEpisode?: number | null;
  createdAt: Date;
  reportCount?: number;
  isLowEffort?: boolean;
}

/** Returns 1 if this post would spoil the viewer (they're behind & not opted in), else 0. */
export function spoilerRiskForViewer(viewer: ViewerContext, a: RankableActivity): number {
  if (!a.spoilerScopeSeriesId) return 0;
  if (viewer.spoilerOptIn.has(a.spoilerScopeSeriesId)) return 0;
  const watched = viewer.progress.get(a.spoilerScopeSeriesId) ?? 0;
  const revealsUpTo = a.spoilerUpToEpisode ?? Number.POSITIVE_INFINITY;
  return watched >= revealsUpTo ? 0 : 1;
}

/** Quality penalty in [0,~1+]: reports, muted-term hits, low-effort flag. */
export function qualityPenalty(viewer: ViewerContext, a: RankableActivity): number {
  let p = 0;
  if (a.reportCount && a.reportCount > 0) p += Math.min(a.reportCount * 0.25, 1);
  if (a.isLowEffort) p += 0.3;
  const body = (a.body ?? '').toLowerCase();
  if (viewer.mutedKeywords.some((k) => body.includes(k))) p += 1; // effectively buries it
  return p;
}

export interface ScoredActivity {
  activity: RankableActivity;
  score: number;
  dominantTerm: string; // for "Why am I seeing this?" + debugging
}

/** Transparent For-You score. Log dominantTerm to catch "everything is just recency" bugs. */
export function relevanceScore(viewer: ViewerContext, a: RankableActivity): ScoredActivity {
  const w = RANKING_CONFIG.relevance;
  const terms: Record<string, number> = {
    affinity: w.affinity * (viewer.affinity.get(a.authorId) ?? 0),
    topicMatch: w.topicMatch * (a.linkedSeriesId ? viewer.seriesAffinity.get(a.linkedSeriesId) ?? 0 : 0),
    velocity: w.velocity * normalizedHot(a, a.createdAt),
    recency: w.recency * recency(a.createdAt),
    spoilerRisk: -w.spoilerRisk * spoilerRiskForViewer(viewer, a),
    qualityPenalty: -w.qualityPenalty * qualityPenalty(viewer, a),
  };
  const score = Object.values(terms).reduce((s, v) => s + v, 0);
  const dominantTerm = Object.entries(terms).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0][0];
  return { activity: a, score, dominantTerm };
}

/**
 * Diversify a ranked list so the viewer doesn't see 5 posts about the same series in a row.
 * Greedy: walk the sorted list, defer an item if its series already appeared within `window`.
 */
export function diversifyBySeries(scored: ScoredActivity[], window = 3): ScoredActivity[] {
  const out: ScoredActivity[] = [];
  const deferred: ScoredActivity[] = [];
  const recentSeries: (string | null)[] = [];

  const pushItem = (item: ScoredActivity) => {
    out.push(item);
    recentSeries.push(item.activity.linkedSeriesId ?? null);
    if (recentSeries.length > window) recentSeries.shift();
  };

  for (const item of scored) {
    const sid = item.activity.linkedSeriesId ?? null;
    if (sid && recentSeries.includes(sid)) deferred.push(item);
    else pushItem(item);
  }
  // Re-insert deferred items at the end (still roughly in score order).
  for (const item of deferred) pushItem(item);
  return out;
}

/** Full For-You pipeline: score → filter blocked → sort → diversify. */
export function rankForYou(
  viewer: ViewerContext,
  candidates: RankableActivity[],
  limit: number,
): ScoredActivity[] {
  const scored = candidates
    .filter((a) => !viewer.blocked.has(a.authorId))
    .map((a) => relevanceScore(viewer, a))
    .sort((x, y) => y.score - x.score);
  return diversifyBySeries(scored).slice(0, limit);
}
