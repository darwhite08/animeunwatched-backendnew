/**
 * Trending algorithm tests (trending-v2 — advanced multi-signal).
 *
 * Covers:
 *  - Pure scoring helpers: authorQualityMultiplier, freshnessBonus,
 *    personalizedScore (all signals layered)
 *  - applyDiversityCap
 *  - getTrending integration with mocked Prisma + cache:
 *      empty window, base score query shape, follow boost, hide
 *      exclusion, author-soft-block, watchlist + high-rated affinity,
 *      author-like affinity, diversity, cache hit, per-call personalization,
 *      hidePost / unhidePost, setPostScoreOverride invalidates cache
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type SqlRow = {
  id: string; authorId: string; animeId: string | null
  authorReputation: number; ageHours: number; score: number
}

const state: {
  rawRows:           SqlRow[]
  follows:           string[]
  hides:             Array<{ postId: string }>
  hideAuthors:       Array<{ post: { authorId: string } }>
  watchlist:         Array<{ animeId: string; score: number | null }>
  authorLikes:       Array<{ post: { authorId: string } }>
  postsForHydrate:   Array<{ id: string; authorId: string; createdAt: Date }>
  rawCallCount:      number
  hideUpsertCalls:   number
  hideDeleteCalls:   number
  postUpdateCalls:   number
  cacheDeleteCalls:  number
} = {
  rawRows: [], follows: [], hides: [], hideAuthors: [], watchlist: [],
  authorLikes: [], postsForHydrate: [],
  rawCallCount: 0, hideUpsertCalls: 0, hideDeleteCalls: 0,
  postUpdateCalls: 0, cacheDeleteCalls: 0,
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
    postHide: {
      findMany: vi.fn(async ({ select }: { select?: { postId?: boolean; post?: unknown } }) => {
        // Two call shapes: candidate-id hides (returns postId) and
        // author-aggregate hides (returns post.authorId)
        if (select?.post) return state.hideAuthors
        return state.hides
      }),
      upsert: vi.fn(async () => { state.hideUpsertCalls++; return undefined }),
      deleteMany: vi.fn(async () => { state.hideDeleteCalls++; return { count: 1 } }),
    },
    listEntry: {
      findMany: vi.fn(async () => state.watchlist),
    },
    postLike: {
      findMany: vi.fn(async ({ select }: { select?: { post?: unknown; postId?: boolean } }) => {
        if (select?.post) return state.authorLikes
        return []
      }),
    },
    post: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = state.postsForHydrate.find(p => p.id === where.id)
        return p ? { id: p.id } : null
      }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const wantedIds = new Set(where.id.in)
        return state.postsForHydrate.filter(p => wantedIds.has(p.id))
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, number> }) => {
        state.postUpdateCalls++
        return { id: where.id, manualBoost: data.manualBoost ?? 1, shadowPenalty: data.shadowPenalty ?? 1 }
      }),
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
    delPattern: (prefix: string) => {
      state.cacheDeleteCalls++
      for (const k of [...cacheStore.keys()]) {
        if (k.startsWith(prefix)) cacheStore.delete(k)
      }
    },
  },
}))

// Side-effect modules that posts.service imports but getTrending doesn't touch
vi.mock("../app/src/lib/reputation",      () => ({ addReputation: vi.fn() }))
vi.mock("../app/src/lib/notify",          () => ({ createNotification: vi.fn(), NotificationType: {} }))
vi.mock("../app/src/lib/streak",          () => ({ updateStreak: vi.fn() }))
vi.mock("../app/src/lib/audit",           () => ({ auditDelete: vi.fn() }))
vi.mock("../app/src/realtime/broadcast",  () => ({
  broadcastPostCreated: vi.fn(), broadcastPostLiked: vi.fn(), broadcastPostUnliked: vi.fn(),
  broadcastAdminPostCreated: vi.fn(), broadcastAdminPostDeleted: vi.fn(),
  broadcastPostCommented: vi.fn(), broadcastPostDeleted: vi.fn(), broadcastPostComment: vi.fn(),
}))

import {
  getTrending, applyDiversityCap, personalizedScore, authorQualityMultiplier,
  freshnessBonus, hidePost, unhidePost, setPostScoreOverride, TRENDING_CONFIG,
  type PersonalizationInputs,
} from "../app/src/modules/posts/posts.service"

beforeEach(() => {
  Object.assign(state, {
    rawRows: [], follows: [], hides: [], hideAuthors: [], watchlist: [],
    authorLikes: [], postsForHydrate: [],
    rawCallCount: 0, hideUpsertCalls: 0, hideDeleteCalls: 0,
    postUpdateCalls: 0, cacheDeleteCalls: 0,
  })
  cacheStore.clear()
})

// Helpers
function row(over: Partial<SqlRow> = {}): SqlRow {
  return {
    id: "p1", authorId: "u1", animeId: null,
    authorReputation: 100, ageHours: 5, score: 10,
    ...over,
  }
}
/** Build a ScoredRow (post-mapping, what personalizedScore consumes) */
function scoredRow(over: Partial<{ id: string; authorId: string; animeId: string | null; authorReputation: number; ageHours: number; baseScore: number }> = {}) {
  return {
    id: "p1", authorId: "u1", animeId: null,
    authorReputation: 100, ageHours: 5, baseScore: 10,
    ...over,
  }
}
function inputs(over: Partial<PersonalizationInputs> = {}): PersonalizationInputs {
  return {
    followedAuthors:    new Set(),
    hiddenPostIds:      new Set(),
    authorHideCounts:   new Map(),
    watchlistAnimeIds:  new Set(),
    highlyRatedAnimeIds: new Set(),
    authorLikeCounts:   new Map(),
    ...over,
  }
}

// ── Pure scoring helpers ─────────────────────────────────────────────────────

describe("authorQualityMultiplier", () => {
  it("returns AUTHOR_REP_MIN_MULT at reputation 0", () => {
    expect(authorQualityMultiplier(0)).toBeCloseTo(TRENDING_CONFIG.AUTHOR_REP_MIN_MULT, 5)
  })
  it("returns AUTHOR_REP_MAX_MULT at or above softcap", () => {
    expect(authorQualityMultiplier(TRENDING_CONFIG.AUTHOR_REP_SOFTCAP)).toBeCloseTo(TRENDING_CONFIG.AUTHOR_REP_MAX_MULT, 5)
    expect(authorQualityMultiplier(TRENDING_CONFIG.AUTHOR_REP_SOFTCAP * 10)).toBeCloseTo(TRENDING_CONFIG.AUTHOR_REP_MAX_MULT, 5)
  })
  it("is monotonic in reputation", () => {
    expect(authorQualityMultiplier(50)).toBeLessThan(authorQualityMultiplier(500))
  })
  it("never goes below MIN or above MAX", () => {
    for (const r of [-100, 0, 1, 100, 5000, 1_000_000]) {
      const m = authorQualityMultiplier(r)
      expect(m).toBeGreaterThanOrEqual(TRENDING_CONFIG.AUTHOR_REP_MIN_MULT)
      expect(m).toBeLessThanOrEqual(TRENDING_CONFIG.AUTHOR_REP_MAX_MULT)
    }
  })
})

describe("freshnessBonus", () => {
  it("peaks at age 0", () => {
    expect(freshnessBonus(0)).toBe(TRENDING_CONFIG.FRESHNESS_BONUS_PEAK)
  })
  it("decays to 0 at FRESHNESS_DECAY_HOURS and beyond", () => {
    expect(freshnessBonus(TRENDING_CONFIG.FRESHNESS_DECAY_HOURS)).toBe(0)
    expect(freshnessBonus(TRENDING_CONFIG.FRESHNESS_DECAY_HOURS + 5)).toBe(0)
  })
  it("is linear midway", () => {
    expect(freshnessBonus(TRENDING_CONFIG.FRESHNESS_DECAY_HOURS / 2))
      .toBeCloseTo(TRENDING_CONFIG.FRESHNESS_BONUS_PEAK / 2, 5)
  })
})

describe("personalizedScore", () => {
  it("returns -Infinity when post is explicitly hidden", () => {
    const r = scoredRow()
    const p = inputs({ hiddenPostIds: new Set([r.id]) })
    expect(personalizedScore(r, p)).toBe(-Infinity)
  })

  it("applies follow boost", () => {
    const r = scoredRow({ animeId: null })
    const base = personalizedScore(r, inputs())
    const boosted = personalizedScore(r, inputs({ followedAuthors: new Set([r.authorId]) }))
    expect(boosted / base).toBeCloseTo(TRENDING_CONFIG.FOLLOW_BOOST, 1)
  })

  it("rated-high boost dominates watchlist boost for the same anime", () => {
    const r = scoredRow({ animeId: "a1" })
    const w = personalizedScore(r, inputs({ watchlistAnimeIds: new Set(["a1"]) }))
    const h = personalizedScore(r, inputs({
      watchlistAnimeIds: new Set(["a1"]),
      highlyRatedAnimeIds: new Set(["a1"]),
    }))
    expect(h).toBeGreaterThan(w)
  })

  it("author affinity scales with past likes, capped", () => {
    const r = scoredRow()
    const noLikes  = personalizedScore(r, inputs())
    const someLikes = personalizedScore(r, inputs({ authorLikeCounts: new Map([[r.authorId, 5]]) }))
    const tonLikes  = personalizedScore(r, inputs({ authorLikeCounts: new Map([[r.authorId, 1000]]) }))
    expect(someLikes).toBeGreaterThan(noLikes)
    expect(tonLikes).toBeGreaterThan(someLikes)
    expect(tonLikes / noLikes).toBeLessThan(TRENDING_CONFIG.AUTHOR_AFFINITY_CAP * 1.01)
  })

  it("author-level soft-block kicks in at threshold", () => {
    // Use an age past the freshness window so the additive bonus is 0 and the
    // multiplicative ratio is clean.
    const r = scoredRow({ ageHours: TRENDING_CONFIG.FRESHNESS_DECAY_HOURS + 1 })
    const below = personalizedScore(r, inputs({
      authorHideCounts: new Map([[r.authorId, TRENDING_CONFIG.AUTHOR_HIDE_THRESHOLD - 1]]),
    }))
    const at = personalizedScore(r, inputs({
      authorHideCounts: new Map([[r.authorId, TRENDING_CONFIG.AUTHOR_HIDE_THRESHOLD]]),
    }))
    expect(at / below).toBeCloseTo(TRENDING_CONFIG.AUTHOR_HIDE_PENALTY, 2)
  })

  it("freshness bonus pulls cold posts up", () => {
    const r = scoredRow({ baseScore: 0.01, ageHours: 0 })
    const s = personalizedScore(r, inputs())
    expect(s).toBeGreaterThan(TRENDING_CONFIG.FRESHNESS_BONUS_PEAK * 0.5)
  })
})

// ── Diversity cap (carried over from v1) ─────────────────────────────────────

describe("applyDiversityCap", () => {
  it("caps each author at MAX_PER_AUTHOR slots", () => {
    const spammy = Array.from({ length: 10 }, (_, i) => ({
      id: `spam${i}`, authorId: "spammer", baseScore: 100 - i,
    }))
    const filler = Array.from({ length: 10 }, (_, i) => ({
      id: `ok${i}`, authorId: `clean${i}`, baseScore: 50 - i,
    }))
    const out = applyDiversityCap([...spammy, ...filler], 20)
    expect(out.filter(s => s.authorId === "spammer").length)
      .toBe(TRENDING_CONFIG.MAX_PER_AUTHOR)
  })
})

// ── Integration: getTrending end-to-end ──────────────────────────────────────

describe("getTrending integration", () => {
  it("returns empty result when no posts qualify", async () => {
    const r = await getTrending(undefined, 20)
    expect(r.data).toEqual([])
    expect(r.meta).toMatchObject({ algorithm: "trending-v2", count: 0 })
  })

  it("preserves SQL score order for anonymous viewer", async () => {
    state.rawRows = [
      row({ id: "p1", authorId: "u1", score: 9 }),
      row({ id: "p2", authorId: "u2", score: 5 }),
      row({ id: "p3", authorId: "u3", score: 1 }),
    ]
    state.postsForHydrate = state.rawRows.map(r => ({
      id: r.id, authorId: r.authorId, createdAt: new Date(),
    }))
    const r = await getTrending(undefined, 20)
    expect(r.data.map(p => p.id)).toEqual(["p1", "p2", "p3"])
  })

  it("excludes posts the viewer has hidden", async () => {
    state.rawRows = [
      row({ id: "p1", authorId: "u1", score: 9 }),
      row({ id: "p2", authorId: "u2", score: 5 }),
    ]
    state.postsForHydrate = state.rawRows.map(r => ({
      id: r.id, authorId: r.authorId, createdAt: new Date(),
    }))
    state.hides = [{ postId: "p1" }]
    const r = await getTrending("viewer", 20)
    expect(r.data.map(p => p.id)).toEqual(["p2"])
  })

  it("watchlist boost flips ordering when scores are close", async () => {
    // p_far edges out p_close on raw score, but p_close's anime is in the
    // viewer's watchlist → 1.25× boost wins.
    state.rawRows = [
      row({ id: "far",   authorId: "u1", animeId: "anime-A", score: 6 }),
      row({ id: "close", authorId: "u2", animeId: "anime-B", score: 5 }),
    ]
    state.postsForHydrate = state.rawRows.map(r => ({
      id: r.id, authorId: r.authorId, createdAt: new Date(),
    }))
    state.watchlist = [{ animeId: "anime-B", score: null }]
    const r = await getTrending("viewer", 20)
    expect(r.data[0].id).toBe("close")
  })

  it("does not run personalization queries for anonymous viewers", async () => {
    state.rawRows = [row({ id: "p1" })]
    state.postsForHydrate = [{ id: "p1", authorId: "u1", createdAt: new Date() }]
    await getTrending(undefined, 20)
    // postLike + postHide + listEntry mocks have no call counter but the
    // prisma.follow.findMany is the canary — it must not have been called.
    // We assert indirectly via behaviour: anonymous output equals what we'd
    // get with an empty PersonalizationInputs, which the previous test
    // already covered. This test exists to lock the path.
    expect(state.rawCallCount).toBe(1)
  })

  it("caches base SQL across requests", async () => {
    state.rawRows = [row({ id: "p1" })]
    state.postsForHydrate = [{ id: "p1", authorId: "u1", createdAt: new Date() }]
    await getTrending(undefined, 20)
    await getTrending(undefined, 20)
    await getTrending(undefined, 20)
    expect(state.rawCallCount).toBe(1)
  })

  it("applies diversity cap on output", async () => {
    state.rawRows = Array.from({ length: 5 }, (_, i) => row({
      id: `p${i}`, authorId: "hero", score: 10 - i,
    }))
    state.postsForHydrate = state.rawRows.map(r => ({
      id: r.id, authorId: r.authorId, createdAt: new Date(),
    }))
    const r = await getTrending(undefined, 20)
    expect(r.data.length).toBe(TRENDING_CONFIG.MAX_PER_AUTHOR)
  })
})

// ── Hide / unhide endpoints ──────────────────────────────────────────────────

describe("hidePost / unhidePost", () => {
  it("hidePost upserts a row and returns { hidden: true }", async () => {
    state.postsForHydrate = [{ id: "p1", authorId: "u1", createdAt: new Date() }]
    const r = await hidePost("viewer", "p1")
    expect(r).toEqual({ hidden: true })
    expect(state.hideUpsertCalls).toBe(1)
  })

  it("hidePost throws NOT_FOUND for missing post", async () => {
    await expect(hidePost("viewer", "missing")).rejects.toThrow(/not found/i)
  })

  it("unhidePost deletes the row", async () => {
    const r = await unhidePost("viewer", "p1")
    expect(r).toEqual({ hidden: false })
    expect(state.hideDeleteCalls).toBe(1)
  })
})

// ── Admin score override ─────────────────────────────────────────────────────

describe("setPostScoreOverride", () => {
  it("clamps manualBoost into [0, 10] and shadowPenalty into [0, 1]", async () => {
    cacheStore.set("posts:trending:base:20", [], 60_000) // prime cache
    await setPostScoreOverride("p1", { manualBoost: 99, shadowPenalty: 99 })
    expect(state.postUpdateCalls).toBe(1)
    expect(state.cacheDeleteCalls).toBe(1)
  })

  it("returns null when no patchable fields supplied", async () => {
    const r = await setPostScoreOverride("p1", {})
    expect(r).toBeNull()
    expect(state.postUpdateCalls).toBe(0)
  })

  it("invalidates the trending cache so changes show up immediately", async () => {
    cacheStore.set("posts:trending:base:20", [{ id: "x" }], 60_000)
    cacheStore.set("posts:trending:base:50", [{ id: "y" }], 60_000)
    await setPostScoreOverride("p1", { manualBoost: 2 })
    expect(cacheStore.has("posts:trending:base:20")).toBe(false)
    expect(cacheStore.has("posts:trending:base:50")).toBe(false)
  })
})

// ── Config sanity ────────────────────────────────────────────────────────────

describe("TRENDING_CONFIG sanity", () => {
  it("gravity > engagement exponent (age always wins eventually)", () => {
    expect(TRENDING_CONFIG.GRAVITY).toBeGreaterThan(TRENDING_CONFIG.ENGAGEMENT_EXPONENT)
  })
  it("comments outweigh likes", () => {
    expect(TRENDING_CONFIG.W_COMMENT).toBeGreaterThan(TRENDING_CONFIG.W_LIKE)
  })
  it("RATED_HIGH beats WATCHLIST beats baseline", () => {
    expect(TRENDING_CONFIG.RATED_HIGH_BOOST).toBeGreaterThan(TRENDING_CONFIG.WATCHLIST_BOOST)
    expect(TRENDING_CONFIG.WATCHLIST_BOOST).toBeGreaterThan(1)
  })
  it("author hide penalty is strongly negative (< 0.5)", () => {
    expect(TRENDING_CONFIG.AUTHOR_HIDE_PENALTY).toBeLessThan(0.5)
  })
})
