/**
 * Pure ranking primitive tests.
 * Covers everything in app/src/lib/ranking.ts — the building blocks shared
 * by anime search, similar-anime, For You recommendations, and who-to-follow.
 */
import { describe, it, expect } from "vitest"
import {
  jaccard, overlapCoeff, linearProximity, logNormalize,
  titleRelevance, bodyRelevance, capPerGroup,
} from "../app/src/lib/ranking"

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(1)
  })
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set([1, 2]), new Set([3, 4]))).toBe(0)
  })
  it("returns 0 when both sets are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(0)
  })
  it("computes overlap correctly for partial intersection", () => {
    // |∩|=2, |∪|=4 → 0.5
    expect(jaccard(new Set([1, 2, 3]), new Set([2, 3, 4]))).toBeCloseTo(0.5, 5)
  })
  it("accepts iterables, not just Sets", () => {
    expect(jaccard([1, 2], [2, 3])).toBeCloseTo(1 / 3, 5)
  })
})

describe("overlapCoeff", () => {
  it("returns 1 when smaller set is a subset of larger", () => {
    expect(overlapCoeff(new Set([1, 2]), new Set([1, 2, 3, 4, 5]))).toBe(1)
  })
  it("returns 0 for disjoint sets", () => {
    expect(overlapCoeff(new Set([1]), new Set([2]))).toBe(0)
  })
  it("returns 0 when either set is empty", () => {
    expect(overlapCoeff(new Set(), new Set([1]))).toBe(0)
    expect(overlapCoeff(new Set([1]), new Set())).toBe(0)
  })
})

describe("linearProximity", () => {
  it("returns 1 for identical values", () => {
    expect(linearProximity(5, 5, 10)).toBe(1)
  })
  it("returns 0 at or beyond span", () => {
    expect(linearProximity(0, 10, 10)).toBe(0)
    expect(linearProximity(0, 20, 10)).toBe(0)
  })
  it("decays linearly", () => {
    expect(linearProximity(0, 5, 10)).toBeCloseTo(0.5, 5)
  })
  it("handles negative span by exact-match check", () => {
    expect(linearProximity(5, 5, 0)).toBe(1)
    expect(linearProximity(5, 6, 0)).toBe(0)
  })
})

describe("logNormalize", () => {
  it("returns 0 for non-positive inputs", () => {
    expect(logNormalize(0, 100)).toBe(0)
    expect(logNormalize(-5, 100)).toBe(0)
  })
  it("returns ~1 at cap", () => {
    expect(logNormalize(100, 100)).toBeCloseTo(1, 5)
  })
  it("clamps above cap to 1", () => {
    expect(logNormalize(10_000, 100)).toBe(1)
  })
  it("is sublinear (10 → ~half of 100's score)", () => {
    expect(logNormalize(10, 100)).toBeLessThan(0.6)
    expect(logNormalize(10, 100)).toBeGreaterThan(0.4)
  })
})

describe("titleRelevance", () => {
  it("returns 100 for case-insensitive exact match", () => {
    expect(titleRelevance("Naruto", "naruto")).toBe(100)
    expect(titleRelevance("naruto", "NARUTO")).toBe(100)
  })
  it("returns 50 for prefix match", () => {
    expect(titleRelevance("Naruto Shippuden", "naruto")).toBe(50)
  })
  it("returns 30 for word-boundary match", () => {
    expect(titleRelevance("The Great Naruto Adventure", "naruto")).toBe(30)
  })
  it("returns 15 for plain substring match", () => {
    expect(titleRelevance("xxnarutoxx", "naruto")).toBe(15)
  })
  it("returns 0 for no match", () => {
    expect(titleRelevance("Bleach", "naruto")).toBe(0)
  })
  it("handles empty inputs", () => {
    expect(titleRelevance("", "naruto")).toBe(0)
    expect(titleRelevance("Naruto", "")).toBe(0)
  })
  it("orders results: exact > prefix > word > substring > none", () => {
    const titles = ["xxnarutoxx", "Naruto", "Naruto Shippuden", "The Naruto Show", "Bleach"]
    const scores = titles.map(t => titleRelevance(t, "naruto"))
    const sorted = [...titles].sort((a, b) => titleRelevance(b, "naruto") - titleRelevance(a, "naruto"))
    expect(sorted[0]).toBe("Naruto")
    expect(scores).toEqual([15, 100, 50, 30, 0])
  })
})

describe("bodyRelevance", () => {
  it("returns 0 for null/empty body", () => {
    expect(bodyRelevance(null, "x")).toBe(0)
    expect(bodyRelevance("", "x")).toBe(0)
    expect(bodyRelevance("anything", "")).toBe(0)
  })
  it("returns 0 when query not present", () => {
    expect(bodyRelevance("hello world", "ninja")).toBe(0)
  })
  it("returns ≥1 when present at least once", () => {
    expect(bodyRelevance("a ninja story", "ninja")).toBeGreaterThanOrEqual(1)
  })
  it("caps at 5 even for many occurrences", () => {
    const body = "ninja ".repeat(100)
    expect(bodyRelevance(body, "ninja")).toBeLessThanOrEqual(5)
  })
  it("is monotonic in occurrence count", () => {
    expect(bodyRelevance("ninja", "ninja"))
      .toBeLessThan(bodyRelevance("ninja ninja ninja ninja ninja", "ninja"))
  })
})

describe("capPerGroup", () => {
  it("respects maxPerGroup", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, group: "A" }))
    const out = capPerGroup(items, x => x.group, 3, 100)
    expect(out.length).toBe(3)
  })
  it("respects limit", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, group: String(i) }))
    expect(capPerGroup(items, x => x.group, 5, 7).length).toBe(7)
  })
  it("preserves order within cap", () => {
    const items = [
      { id: 1, group: "A" },
      { id: 2, group: "B" },
      { id: 3, group: "A" },
      { id: 4, group: "A" }, // dropped — A already at cap=2
      { id: 5, group: "B" },
    ]
    const out = capPerGroup(items, x => x.group, 2, 10)
    expect(out.map(x => x.id)).toEqual([1, 2, 3, 5])
  })
})
