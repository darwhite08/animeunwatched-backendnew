/**
 * Advanced pagination tests.
 */
import { describe, it, expect } from "vitest";

// Replicate the exact paginate and meta helpers used across all services
function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit }
}

function buildMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) }
}

describe("paginate — edge cases", () => {
  it("handles page 1 correctly", () => {
    expect(paginate(1, 20)).toEqual({ skip: 0, take: 20 })
  })

  it("handles page 100 correctly", () => {
    const { skip, take } = paginate(100, 20)
    expect(skip).toBe(1980)
    expect(take).toBe(20)
  })

  it("handles limit of 1 (one item per page)", () => {
    expect(paginate(1, 1)).toEqual({ skip: 0, take: 1 })
    expect(paginate(5, 1)).toEqual({ skip: 4, take: 1 })
  })

  it("handles limit of 100", () => {
    expect(paginate(1, 100)).toEqual({ skip: 0, take: 100 })
    expect(paginate(2, 100)).toEqual({ skip: 100, take: 100 })
  })

  it("skip is always (page - 1) * limit", () => {
    for (let page = 1; page <= 10; page++) {
      const limit = 20
      expect(paginate(page, limit).skip).toBe((page - 1) * limit)
    }
  })
})

describe("buildMeta — edge cases", () => {
  it("handles total of 0", () => {
    const meta = buildMeta(0, 1, 20)
    expect(meta.pages).toBe(0)
    expect(meta.total).toBe(0)
  })

  it("handles total of 1", () => {
    const meta = buildMeta(1, 1, 20)
    expect(meta.pages).toBe(1)
  })

  it("handles total exactly equal to limit", () => {
    expect(buildMeta(20, 1, 20).pages).toBe(1)
  })

  it("handles total one more than limit", () => {
    expect(buildMeta(21, 1, 20).pages).toBe(2)
  })

  it("handles very large totals", () => {
    const meta = buildMeta(1_000_000, 1, 20)
    expect(meta.pages).toBe(50_000)
    expect(meta.total).toBe(1_000_000)
  })

  it("preserves page and limit in meta", () => {
    const meta = buildMeta(100, 3, 15)
    expect(meta.page).toBe(3)
    expect(meta.limit).toBe(15)
  })

  it("is consistent with paginate output", () => {
    const total = 150
    const page = 2
    const limit = 20
    const { skip, take } = paginate(page, limit)
    const meta = buildMeta(total, page, limit)

    // There should be more pages after this one
    expect(skip + take < total).toBe(meta.pages > page)
  })
})
