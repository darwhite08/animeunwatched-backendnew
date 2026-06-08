/**
 * Trending detector math — verifies the SOTA streaming recursions behave:
 * O(1) state, deseasonalization, MAD robust-z, NEWMA spike, anti-flicker,
 * cold-start damping. (docs/trending-algorithm.md §11b)
 */
import { describe, it, expect } from "vitest";
import {
  TREND,
  ewma,
  initialTrendingState,
  lambdaPerHour,
  percentile,
  stepTrending,
  type TrendingStateLike,
} from "../app/src/lib/trending/trendingMath";

const baseInput = (velocity: number, over: Partial<Parameters<typeof stepTrending>[1]> = {}) => ({
  velocity,
  uniqueUsers: 10,
  weekday: 3,
  velocityP95: 100,
  ...over,
});

describe("primitives", () => {
  it("lambda = ln2 / half-life", () => {
    expect(lambdaPerHour(24)).toBeCloseTo(Math.LN2 / 24, 10);
  });
  it("ewma blends old and new", () => {
    expect(ewma(0, 10, 0.5)).toBe(5);
    expect(ewma(10, 10, 0.1)).toBe(10);
  });
  it("percentile is nearest-rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("stepTrending", () => {
  it("produces O(1) state (a handful of fixed-size floats)", () => {
    const { next } = stepTrending(initialTrendingState(), baseInput(50));
    expect(next.seasonal).toHaveLength(7);
    expect(Object.keys(next).sort()).toEqual(
      ["ewmaDev", "ewmaMean", "newmaFast", "newmaSlow", "prevScore", "samples", "seasonal"].sort(),
    );
  });

  it("cold-start: first steps are damped (warmup), score stays modest", () => {
    const { score, next } = stepTrending(initialTrendingState(), baseInput(1000));
    expect(next.samples).toBe(1);
    // warmup = 1/6 on the first sample → burst contribution heavily damped
    expect(score).toBeLessThan(0.5);
  });

  it("detects a genuine burst once warmed: a spike scores far above steady state", () => {
    // Feed a steady low velocity to warm the baseline, then spike.
    let s: TrendingStateLike = initialTrendingState();
    for (let i = 0; i < 12; i++) s = stepTrending(s, baseInput(5)).next;
    const steady = stepTrending(s, baseInput(5));
    const spike = stepTrending(s, baseInput(80)); // 16× jump
    expect(spike.z).toBeGreaterThan(steady.z);
    expect(spike.newmaBurst).toBeGreaterThan(steady.newmaBurst);
    expect(spike.score).toBeGreaterThan(steady.score);
  });

  it("deseasonalization: a show that ALWAYS spikes on its airing weekday isn't 'trending'", () => {
    // Saturday (wd=6) velocity is persistently high; the per-weekday seasonal
    // EWMA should absorb it so the residual (and z) stay low over time.
    let s: TrendingStateLike = initialTrendingState();
    let lastZ = Infinity;
    for (let week = 0; week < 8; week++) {
      // low on weekdays, high every Saturday
      for (let d = 0; d < 7; d++) {
        const v = d === 6 ? 100 : 5;
        const r = stepTrending(s, baseInput(v, { weekday: d }));
        s = r.next;
        if (d === 6) lastZ = r.z;
      }
    }
    // After several weeks, the recurring Saturday pulse is learned as seasonal →
    // its burst z should have decayed toward 0 (not flagged as trending).
    expect(lastZ).toBeLessThan(2);
  });

  it("anti-flicker: smoothing keeps consecutive scores from jumping fully to raw", () => {
    let s: TrendingStateLike = initialTrendingState();
    for (let i = 0; i < 12; i++) s = stepTrending(s, baseInput(5)).next;
    const prev = s.prevScore;
    const { score } = stepTrending(s, baseInput(200));
    // score is a β-blend of raw and prev, so it can't equal the raw spike outright
    expect(score).toBeGreaterThan(prev);
    expect(Math.abs(score - prev)).toBeLessThan(1); // bounded step
  });

  it("airing + episode pulse boost the score multiplicatively", () => {
    let s: TrendingStateLike = initialTrendingState();
    for (let i = 0; i < 12; i++) s = stepTrending(s, baseInput(5)).next;
    const plain = stepTrending(s, baseInput(40));
    const boosted = stepTrending(s, baseInput(40, { airing: true, episodePulse: true }));
    expect(boosted.score).toBeGreaterThan(plain.score);
  });

  it("z is clamped to Z_MAX", () => {
    let s: TrendingStateLike = initialTrendingState();
    for (let i = 0; i < 12; i++) s = stepTrending(s, baseInput(1)).next;
    const { z } = stepTrending(s, baseInput(1e6));
    expect(z).toBeLessThanOrEqual(TREND.Z_MAX);
  });

  it("confidence shrinkage: a noisy spike from few users scores below the same spike from many", () => {
    // Warm two identical baselines, then spike both with the same velocity but
    // different unique-user counts. The broad spike must outscore the narrow one.
    const warm = (over: object) => {
      let s: TrendingStateLike = initialTrendingState();
      for (let i = 0; i < 12; i++) s = stepTrending(s, baseInput(5, over)).next;
      return s;
    };
    const sFew = warm({ uniqueUsers: 2 });
    const sMany = warm({ uniqueUsers: 60 });
    const few = stepTrending(sFew, baseInput(60, { uniqueUsers: 2 }));
    const many = stepTrending(sMany, baseInput(60, { uniqueUsers: 60 }));
    expect(many.score).toBeGreaterThan(few.score);
  });

  it("external web buzz is NOT confidence-damped (a web-only title still scores)", () => {
    // No on-platform users at all, but strong web buzz → should still score.
    const { score } = stepTrending(initialTrendingState(), baseInput(0, { uniqueUsers: 0, externalBuzz: 0.9 }));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(TREND.SMOOTH_BETA * TREND.W_EXT * 0.9, 5);
  });
});
