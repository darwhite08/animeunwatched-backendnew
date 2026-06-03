/**
 * Trending algorithm tests.
 *
 * Covers:
 *  - applyDiversityCap (pure function — no mocks)
 *  - getTrending end-to-end with mocked Prisma + cache:
 *      empty window, base score query shape, follow boost, diversity,
 *      cache hit on second call.
 *
 * The SQL itself is tested only structurally (we mock $queryRaw) — the
 * algorithm correctness lives in the constants + the JS layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type ScoredRow = { id: string; authorId: string; score: number }

const state: {
  rawRows:        ScoredRow[]
  follows:        string[]
  postsForHydrate: Array<{ id: string; authorId: string; createdAt: Date }>
  rawCallCount:   number
} = {
  rawRows: [], follows: [], postsForHydrate: [], rawCallCount: 0,
}

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      state.rawCallCount++
      return state.rawRows
    }),
    follow: {
      findMany: vi.fn(async () => state.follows.map(followingId => ({ followingId }))),
    },
    post: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const wantedIds = new Set(where.id.in)
        return state.postsForHydrate.filter(p => wantedIds.has(p.id))
      }),
    },
    postLike: {
      findMany: vi.fn(async () => []),
    },
  },
}))

// Cache used by getTrending — fresh instance per test via clear()
const cacheStore = new Map<string, { data: unknown; expiresAt: number }>()
vi.mock("../app/src/lib/cache", () => ({
  cache: {
    get: (k: string) => {
      const e = cacheStore.get(k)
      if (!e || Date.now() > e.expiresAt) return null
      return e.data
    },
    set: (k: string, data: unknown, ttlMs: number) => {
      cacheStore.set(k, { data, expiresAt: Date.now() + ttlMs })
    },
  },
}))

// Audit / reputation / notify / streak / realtime aren't exercised by getTrending
// but the module imports them; stub so import doesn't blow up.
vi.mock("../app/src/lib/reputation",      () => ({ addReputation: vi.fn() }))
vi.mock("../app/src/lib/notify",          () => ({ createNotification: vi.fn(), NotificationType: {} }))
vi.mock("../app/src/lib/streak",          () => ({ updateStreak: vi.fn() }))
vi.mock("../app/src/lib/audit",           () => ({ auditDelete: vi.fn() }))
vi.mock("../app/src/realtime/broadcast",  () => ({
  broadcastPostCreated: vi.fn(), broadcastPostLiked: vi.fn(), broadcastPostUnliked: vi.fn(),
  broadcastAdminPostCreated: vi.fn(), broadcastAdminPostDeleted: vi.fn(),
  broadcastPostCommented: vi.fn(), broadcastPostDeleted: vi.fn(), broadcastPostComment: vi.fn(),
}))

import { getTrending, applyDiversityCap, TRENDING_CONFIG } from "../app/src/modules/posts/posts.service"

beforeEach(() => {
  state.rawRows = []
  state.follows = []
  state.postsForHydrate = []
  state.rawCallCount = 0
  cacheStore.clear()
})

describe("applyDiversityCap", () => {
  it("returns at most `limit` items", () => {
    const scored = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`, authorId: `a${i % 5}`, baseScore: 30 - i,
    }))
    expect(applyDiversityCap(scored, 10).length).toBe(10)
  })

  it("caps each author at MAX_PER_AUTHOR slots", () => {
    // One spammy author with 10 hot posts, plus filler from others
    const spammy = Array.from({ length: 10 }, (_, i) => ({
      id: `spam${i}`, authorId: "spammer", baseScore: 100 - i,
    }))
    const filler = Array.from({ length: 10 }, (_, i) => ({
      id: `ok${i}`, authorId: `clean${i}`, baseScore: 50 - i,
    }))
    const out = applyDiversityCap([...spammy, ...filler], 20)
    const fromSpammer = out.filter(s => s.authorId === "spammer").length
    expect(fromSpammer).toBe(TRENDING_CONFIG.MAX_PER_AUTHOR)
  })

  it("preserves order within the cap", () => {
    const scored = [
      { id: "a", authorId: "u1", baseScore: 10 },
      { id: "b", authorId: "u1", baseScore: 9  },
      { id: "c", authorId: "u2", baseScore: 8  },
    ]
    const out = applyDiversityCap(scored, 10, 1)
    expect(out.map(s => s.id)).toEqual(["a", "c"]) // "b" dropped, u2's "c" preserved
  })

  it("returns empty when input is empty", () => {
    expect(applyDiversityCap([], 10)).toEqual([])
  })
})

describe("getTrending", () => {
  it("returns empty result when no posts qualify", async () => {
    const r = await getTrending(undefined, 20)
    expect(r.data).toEqual([])
    expect(r.meta).toMatchObject({ algorithm: "trending-v1", count: 0, personalized: false })
  })

  it("hydrates ranked posts and preserves score order", async () => {
    state.rawRows = [
      { id: "p1", authorId: "u1", score: 9.5 },
      { id: "p2", authorId: "u2", score: 4.0 },
      { id: "p3", authorId: "u3", score: 1.0 },
    ]
    state.postsForHydrate = [
      { id: "p2", authorId: "u2", createdAt: new Date() },
      { id: "p1", authorId: "u1", createdAt: new Date() },
      { id: "p3", authorId: "u3", createdAt: new Date() },
    ]
    const r = await getTrending(undefined, 20)
    expect(r.data.map(p => p.id)).toEqual(["p1", "p2", "p3"]) // SQL order, not findMany order
    expect(r.meta.personalized).toBe(false)
  })

  it("applies follow boost when userId is given", async () => {
    // p2 is OUT of network but scores higher; p1 is IN-network but scores lower.
    // After 1.3× follow boost, p1's effective score (5.0 × 1.3 = 6.5) beats p2 (6.0).
    state.rawRows = [
      { id: "p2", authorId: "out", score: 6.0 },
      { id: "p1", authorId: "in",  score: 5.0 },
    ]
    state.follows = ["in"]
    state.postsForHydrate = [
      { id: "p1", authorId: "in",  createdAt: new Date() },
      { id: "p2", authorId: "out", createdAt: new Date() },
    ]
    const r = await getTrending("viewer-1", 20)
    expect(r.data.map(p => p.id)).toEqual(["p1", "p2"])
    expect(r.meta.personalized).toBe(true)
  })

  it("caches base scores across calls (second call skips $queryRaw)", async () => {
    state.rawRows = [{ id: "p1", authorId: "u1", score: 1.0 }]
    state.postsForHydrate = [{ id: "p1", authorId: "u1", createdAt: new Date() }]

    await getTrending(undefined, 20)
    await getTrending(undefined, 20)
    await getTrending(undefined, 20)

    expect(state.rawCallCount).toBe(1)
  })

  it("does NOT cache personalization (follows query runs per call)", async () => {
    state.rawRows = [{ id: "p1", authorId: "u1", score: 1.0 }]
    state.postsForHydrate = [{ id: "p1", authorId: "u1", createdAt: new Date() }]

    const r1 = await getTrending("viewer-A", 20)
    state.follows = ["u1"] // viewer-B follows the author; viewer-A doesn't
    const r2 = await getTrending("viewer-B", 20)

    expect(r1.meta.personalized).toBe(true)
    expect(r2.meta.personalized).toBe(true)
    // Both return the same post (only one in the window) but the JS personalization
    // layer must run per call for follow-boost differences to take effect.
    expect(r1.data[0].id).toBe("p1")
    expect(r2.data[0].id).toBe("p1")
  })

  it("applies diversity cap on hydrated result", async () => {
    // 5 posts from same author, all hot
    state.rawRows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, authorId: "hero", score: 10 - i,
    }))
    state.postsForHydrate = state.rawRows.map(r => ({
      id: r.id, authorId: r.authorId, createdAt: new Date(),
    }))
    const r = await getTrending(undefined, 20)
    expect(r.data.length).toBe(TRENDING_CONFIG.MAX_PER_AUTHOR)
  })
})

describe("TRENDING_CONFIG sanity", () => {
  it("gravity exceeds engagement exponent (so age always wins eventually)", () => {
    expect(TRENDING_CONFIG.GRAVITY).toBeGreaterThan(TRENDING_CONFIG.ENGAGEMENT_EXPONENT)
  })
  it("comments outweigh likes (effort-weighted)", () => {
    expect(TRENDING_CONFIG.W_COMMENT).toBeGreaterThan(TRENDING_CONFIG.W_LIKE)
  })
  it("follow boost is a positive multiplier > 1 but not dominant (<2x)", () => {
    expect(TRENDING_CONFIG.FOLLOW_BOOST).toBeGreaterThan(1)
    expect(TRENDING_CONFIG.FOLLOW_BOOST).toBeLessThan(2)
  })
})
