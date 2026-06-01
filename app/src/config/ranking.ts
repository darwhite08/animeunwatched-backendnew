/**
 * Feed ranking weights — tunable from env without redeploying logic.
 *
 * Override any value by setting the matching env var. Leaving them unset
 * keeps the FEED_IMPLEMENTATION.md spec defaults.
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const RANKING_CONFIG = {
  weights: {
    like:   num("RANK_W_LIKE",   1),
    reply:  num("RANK_W_REPLY",  4),
    repost: num("RANK_W_REPOST", 5),
    save:   num("RANK_W_SAVE",   3),
    quote:  num("RANK_W_QUOTE",  5),
  },
  hotDecaySeconds:      num("RANK_HOT_DECAY_SECONDS",   45_000),
  epochSeconds:         num("RANK_EPOCH_SECONDS",       1_700_000_000),
  recencyHalfLifeHours: num("RANK_RECENCY_HALF_LIFE_H", 12),
  wilsonZ:              num("RANK_WILSON_Z",            1.281551565545),
  relevance: {
    affinity:       num("RANK_REL_AFFINITY",        2.0),
    topicMatch:     num("RANK_REL_TOPIC_MATCH",     1.5),
    velocity:       num("RANK_REL_VELOCITY",        1.0),
    recency:        num("RANK_REL_RECENCY",         0.5),
    spoilerRisk:    num("RANK_REL_SPOILER_RISK",    3.0),
    qualityPenalty: num("RANK_REL_QUALITY_PENALTY", 2.0),
  },
} as const;
