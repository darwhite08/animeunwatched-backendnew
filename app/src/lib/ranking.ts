/**
 * Shared ranking primitives — pure functions reused across anime search,
 * similar-anime, "For You" recommendations, and who-to-follow.
 *
 * Design principles (informed by the social-feed research synthesised in
 * posts.service trending-v2):
 *
 *   1. Multi-signal scoring beats single-feature sort by ~everything.
 *      Even raw `score DESC` is a bad search because the best match for
 *      "naruto" might be the highest-rated anime regardless of title.
 *   2. Sublinear scaling of quality signals so a 9.5-rated anime isn't
 *      ~2× a 4.5 — log10 keeps the multiplier sane.
 *   3. Diversity caps where appropriate (e.g., don't recommend 5 entries
 *      from the same franchise via the same studio).
 *
 * All functions here are pure (no Prisma, no IO) and trivially testable.
 */

// ─── Set similarity ──────────────────────────────────────────────────────────

/** Jaccard index = |A ∩ B| / |A ∪ B|. 0 → no overlap, 1 → identical sets. */
export function jaccard<T>(a: ReadonlySet<T> | Iterable<T>, b: ReadonlySet<T> | Iterable<T>): number {
  const A = a instanceof Set ? a : new Set(a)
  const B = b instanceof Set ? b : new Set(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

/** Overlap coefficient = |A ∩ B| / min(|A|, |B|). Better than Jaccard for
 *  comparing a small set against a large one (e.g., one studio vs many). */
export function overlapCoeff<T>(a: ReadonlySet<T> | Iterable<T>, b: ReadonlySet<T> | Iterable<T>): number {
  const A = a instanceof Set ? a : new Set(a)
  const B = b instanceof Set ? b : new Set(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

// ─── Numeric similarity ──────────────────────────────────────────────────────

/** Maps |a-b| in [0, span] → [1, 0] linearly. Beyond span → 0. */
export function linearProximity(a: number, b: number, span: number): number {
  if (span <= 0) return a === b ? 1 : 0
  const d = Math.abs(a - b)
  if (d >= span) return 0
  return 1 - d / span
}

/** Log10-normalised quality score in [0, 1]. Cap defines the value at which
 *  the score plateaus at 1.0 (anything ≥ cap maps to 1.0). */
export function logNormalize(value: number, cap: number): number {
  if (value <= 0 || cap <= 0) return 0
  return Math.min(1, Math.log10(value + 1) / Math.log10(cap + 1))
}

// ─── String matching for search relevance ────────────────────────────────────

/**
 * Title-vs-query relevance band. Returns a numeric score reflecting how
 * "this title matches this query" — the same ordering most users intuit
 * when typing into a search box.
 *
 *   exact match (case-insensitive)        → 100
 *   prefix match                          → 50
 *   word boundary match (\bq)             → 30
 *   substring match                       → 15
 *   none                                  → 0
 *
 * Pure JS; safe to call on a hundred items but for SQL-side ranking the
 * caller should emit a matching CASE WHEN expression to avoid loading
 * all candidates into Node. See `searchRankExpr` for the SQL twin.
 */
export function titleRelevance(title: string, query: string): number {
  if (!title || !query) return 0
  const t = title.toLowerCase().trim()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  if (t === q)                          return 100
  if (t.startsWith(q))                  return 50
  if (new RegExp(`\\b${escapeRegex(q)}`, "i").test(t)) return 30
  if (t.includes(q))                    return 15
  return 0
}

/** Body-vs-query relevance (for synopsis / blog body etc). Weaker signal
 *  than title — caps at ~5 so it can break ties between equally-titled
 *  hits but never dominates a title match. */
export function bodyRelevance(body: string | null | undefined, query: string): number {
  if (!body || !query) return 0
  const b = body.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  if (!b.includes(q)) return 0
  // More occurrences → slightly higher score (caps at 5)
  const matches = b.split(q).length - 1
  return Math.min(5, 1 + Math.log2(matches))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ─── Diversity caps ──────────────────────────────────────────────────────────

/**
 * Cap the number of items per group in a sorted list, preserving rank order.
 * Generalises the per-author cap in the trending feed.
 *
 *   capPerGroup(items, x => x.authorId, 2, 20)
 *
 * Returns up to `limit` items, with no more than `maxPerGroup` from any
 * single group.
 */
export function capPerGroup<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  maxPerGroup: number,
  limit: number,
): T[] {
  const counts = new Map<string, number>()
  const out: T[] = []
  for (const item of items) {
    const g = groupOf(item)
    const n = counts.get(g) ?? 0
    if (n < maxPerGroup) {
      out.push(item)
      counts.set(g, n + 1)
    }
    if (out.length >= limit) break
  }
  return out
}
