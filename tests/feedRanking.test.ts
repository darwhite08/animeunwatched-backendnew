import { describe, it, expect } from "vitest";
import {
  engagementWeight, hotScore, wilsonScore, recency, normalizedHot, diversifyBySeries,
} from "../app/src/lib/feedRanking";
import { RANKING_CONFIG } from "../app/src/config/ranking";

describe("engagementWeight", () => {
  it("weights replies/reposts above likes per RANKING_CONFIG.weights", () => {
    const w = RANKING_CONFIG.weights;
    const counts = { likeCount: 10, replyCount: 5, repostCount: 2, saveCount: 1 };
    const expected =
      10 * w.like + 5 * w.reply + 2 * w.repost + 1 * w.save;
    expect(engagementWeight(counts)).toBe(expected);
  });

  it("treats quoteCount as 0 when omitted", () => {
    const a = engagementWeight({ likeCount: 0, replyCount: 0, repostCount: 0, saveCount: 0 });
    const b = engagementWeight({ likeCount: 0, replyCount: 0, repostCount: 0, saveCount: 0, quoteCount: 0 });
    expect(a).toBe(b);
  });
});

describe("hotScore", () => {
  const counts = { likeCount: 5, replyCount: 2, repostCount: 0, saveCount: 0 };

  it("is monotonic in time for equal engagement", () => {
    const older = hotScore(counts, new Date("2025-01-01T00:00:00Z"));
    const newer = hotScore(counts, new Date("2025-06-01T00:00:00Z"));
    expect(newer).toBeGreaterThan(older);
  });

  it("is deterministic — same inputs → same output", () => {
    const t = new Date("2025-05-01T12:00:00Z");
    expect(hotScore(counts, t)).toBe(hotScore(counts, t));
  });

  it("rounds to 7 decimal places", () => {
    const score = hotScore(counts, new Date());
    const decimals = score.toString().split(".")[1] ?? "";
    expect(decimals.length).toBeLessThanOrEqual(7);
  });
});

describe("wilsonScore", () => {
  it("returns 0 when there are no votes", () => {
    expect(wilsonScore(0, 0)).toBe(0);
  });

  it("ranks 10/1 above 1/0 (evidence beats ratio)", () => {
    expect(wilsonScore(10, 1)).toBeGreaterThan(wilsonScore(1, 0));
  });

  it("never exceeds the observed positive ratio", () => {
    const up = 7, down = 3;
    const score = wilsonScore(up, down);
    expect(score).toBeLessThanOrEqual(up / (up + down));
  });
});

describe("recency", () => {
  it("returns 1 at t=now", () => {
    const now = new Date();
    expect(recency(now, now)).toBeCloseTo(1, 5);
  });

  it("halves after RANKING_CONFIG.recencyHalfLifeHours", () => {
    const now    = new Date();
    const halfAt = new Date(now.getTime() - RANKING_CONFIG.recencyHalfLifeHours * 3_600_000);
    expect(recency(halfAt, now)).toBeCloseTo(0.5, 5);
  });
});

describe("normalizedHot", () => {
  it("clamps to [0,1]", () => {
    const huge = { likeCount: 1e9, replyCount: 1e9, repostCount: 1e9, saveCount: 1e9 };
    const v = normalizedHot(huge, new Date());
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("diversifyBySeries", () => {
  it("avoids more than `window` consecutive items from the same series", () => {
    const mkScored = (id: string, seriesId: string | null) => ({
      activity: { id, linkedSeriesId: seriesId } as Parameters<typeof diversifyBySeries>[0][number]["activity"],
      score: 1,
      dominantTerm: "recency",
    });
    const items = [
      mkScored("1", "A"), mkScored("2", "A"), mkScored("3", "A"),
      mkScored("4", "A"), mkScored("5", "B"), mkScored("6", "C"),
    ];
    const out = diversifyBySeries(items, 2);
    expect(out.length).toBe(items.length);
    // First two slots cannot both come before more A's; one A should be deferred.
    expect(out[0].activity.linkedSeriesId).toBe("A");
    // At least one non-A appears within the first 4 slots
    const firstFourSeries = out.slice(0, 4).map(o => o.activity.linkedSeriesId);
    expect(firstFourSeries.some(s => s !== "A")).toBe(true);
  });
});
