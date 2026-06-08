/**
 * Trending detector — pure streaming math (no I/O, fully unit-testable).
 *
 * Implements the research-verified SOTA pipeline (docs/trending-algorithm.md §11b),
 * every step O(1) recursive state, NO history rescan:
 *
 *   velocity → S-H-ESD deseasonalize → MAD robust-z → NEWMA spike → smoothed score
 *
 * Sources (verified 3-0): S-H-ESD = Twitter AnomalyDetection (median + 1.4826·MAD);
 * NEWMA = two-EWMA change detector; exponential-decay velocity = folklore O(1).
 */

// ── Tuning defaults (docs §10) — starting points to measure, not gospel. ──
export const TREND = {
  HALF_LIFE_H: 24, // velocity decay half-life (hours) → "right now" feel
  WINDOW_DAYS: 14, // how far back the velocity aggregate scans (decay ≈ 0 beyond)
  ALPHA_BASE: 0.1, // EWMA rate for the robust-z mean/deviation baseline
  ALPHA_SEASON: 0.15, // EWMA rate for the per-weekday seasonal component
  NEWMA_FAST: 0.5, // fast EWMA rate (reacts in ~2 ticks)
  NEWMA_SLOW: 0.05, // slow EWMA rate (baseline over ~20 ticks)
  SMOOTH_BETA: 0.5, // anti-flicker: score ← β·raw + (1-β)·prev
  Z_MAX: 8, // robust-z clamp
  WARMUP_SAMPLES: 6, // below this many updates, damp burst (cold-start)
  MIN_UNIQUE_USERS: 2, // anti-gaming eligibility floor (on-platform)
  MIN_EXTERNAL_BUZZ: 0.05, // a title can qualify on web buzz alone above this
  CONFIDENCE_K: 4, // unique-user confidence: conf = u/(u+K) → 4 users ≈ 0.5, 20 ≈ 0.83
  USER_CONTRIB_CAP: 4, // max weighted decayed contribution counted from any ONE user (anti-spam)
  // Signal-type weights — effort/intent strength (a review ≫ a one-click list add).
  W_SIGNAL: { listEntry: 1.0, activity: 1.5, post: 1.5, review: 3.0, thread: 2.0 } as Record<string, number>,
  W_BURST: 0.4, // weight: on-platform acceleration (robust-z)
  W_NEWMA: 0.15, // weight: NEWMA spike confirmation
  W_MAG: 0.15, // weight: on-platform magnitude (unique-user reach)
  W_EXT: 0.3, // weight: off-platform web buzz (AniList + Wikipedia)
} as const;

/** Decay constant λ = ln2 / half-life. */
export const lambdaPerHour = (halfLifeH = TREND.HALF_LIFE_H): number => Math.LN2 / halfLifeH;

/** EWMA update: s ← (1-α)·s + α·x. */
export function ewma(prev: number, x: number, alpha: number): number {
  return (1 - alpha) * prev + alpha * x;
}

export interface TrendingStateLike {
  ewmaMean: number;
  ewmaDev: number;
  newmaFast: number;
  newmaSlow: number;
  seasonal: number[]; // length 7, indexed by weekday (0=Sun..6=Sat)
  prevScore: number;
  samples: number;
}

export interface TrendingInput {
  velocity: number; // decayed event velocity this tick (on-platform)
  uniqueUsers: number; // distinct users behind it (anti-gaming)
  weekday: number; // 0..6
  velocityP95: number; // p95 of velocity across the candidate set (for magnitude norm)
  externalBuzz?: number; // off-platform web buzz, normalized 0..1 (AniList + Wikipedia)
  airing?: boolean;
  episodePulse?: boolean; // an episode aired within the decay window
}

export interface TrendingResult {
  score: number; // final smoothed trendingScore
  z: number; // robust-z burst (deseasonalized)
  newmaBurst: number; // NEWMA spike component
  next: TrendingStateLike; // updated state to persist
}

const EPS = 1e-9;

/**
 * One streaming step. Returns the new score + the next state to persist.
 * All updates are O(1) on a handful of floats.
 */
export function stepTrending(state: TrendingStateLike, input: TrendingInput): TrendingResult {
  const v = Math.max(0, input.velocity);
  const seasonal = state.seasonal.length === 7 ? [...state.seasonal] : [0, 0, 0, 0, 0, 0, 0];

  // ── 1. S-H-ESD deseasonalization (streaming approximation) ──────────────
  // Per-weekday EWMA estimates the weekly seasonal pulse; the residual is what
  // remains after "every Saturday-airing show spikes Saturday" is removed.
  const wd = ((input.weekday % 7) + 7) % 7;
  const seasonalComponent = seasonal[wd];
  const residual = v - seasonalComponent; // S-H-ESD: X − seasonal (− median, tracked as ewmaMean below)
  seasonal[wd] = ewma(seasonalComponent, v, TREND.ALPHA_SEASON);

  // ── 2. MAD robust-z on the residual ─────────────────────────────────────
  // ewmaMean plays the role of S-H-ESD's median centre; ewmaDev tracks the
  // mean-abs-deviation so σ̂ = 1.4826·ewmaDev (robust to the spikes themselves).
  const centred = residual - state.ewmaMean;
  const sigma = 1.4826 * state.ewmaDev + EPS;
  const zRaw = centred / sigma;
  const z = Math.max(0, Math.min(TREND.Z_MAX, zRaw));

  const nextMean = ewma(state.ewmaMean, residual, TREND.ALPHA_BASE);
  const nextDev = ewma(state.ewmaDev, Math.abs(residual - state.ewmaMean), TREND.ALPHA_BASE);

  // ── 3. NEWMA spike detector (two-EWMA comparison, O(1), no prior) ────────
  const fast = ewma(state.newmaFast, v, TREND.NEWMA_FAST);
  const slow = ewma(state.newmaSlow, v, TREND.NEWMA_SLOW);
  const newmaBurst = Math.max(0, (fast - slow) / (slow + 1)); // relative jump, ≥0

  // ── 4. Magnitude (unique-user reach), p95-normalized so one title can't dominate
  const magnitude = input.velocityP95 > EPS ? Math.min(1, v / input.velocityP95) : 0;

  // ── 5. Blend → boosts → cold-start/confidence damp → EWMA smoothing ─────
  // On-platform acceleration is damped by BOTH warmup (enough history?) and
  // confidence (enough distinct users? — a noisy z from 2 users shouldn't beat
  // a steady signal from 50). The external web-buzz signal carries its own
  // breadth (AniList community + Wikipedia readers) so it isn't damped.
  const warmup = Math.min(1, state.samples / TREND.WARMUP_SAMPLES); // 0..1
  const confidence = input.uniqueUsers / (input.uniqueUsers + TREND.CONFIDENCE_K); // 0..1
  const onPlatformDamp = warmup * confidence;
  const externalBuzz = Math.max(0, Math.min(1, input.externalBuzz ?? 0));
  let raw =
    TREND.W_BURST * (z / TREND.Z_MAX) * onPlatformDamp +
    TREND.W_NEWMA * Math.min(1, newmaBurst) * onPlatformDamp +
    TREND.W_MAG * magnitude +
    TREND.W_EXT * externalBuzz;

  if (input.airing) raw *= 1.25;
  if (input.episodePulse) raw *= 1.2;

  const score = TREND.SMOOTH_BETA * raw + (1 - TREND.SMOOTH_BETA) * state.prevScore;

  return {
    score,
    z,
    newmaBurst,
    next: {
      ewmaMean: nextMean,
      ewmaDev: nextDev,
      newmaFast: fast,
      newmaSlow: slow,
      seasonal,
      prevScore: score,
      samples: state.samples + 1,
    },
  };
}

/** Fresh state for a title we've never scored. */
export function initialTrendingState(): TrendingStateLike {
  return {
    ewmaMean: 0,
    ewmaDev: 0,
    newmaFast: 0,
    newmaSlow: 0,
    seasonal: [0, 0, 0, 0, 0, 0, 0],
    prevScore: 0,
    samples: 0,
  };
}

/** p95 of a numeric array (nearest-rank). Used to normalize magnitude per tick. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
