# Shots recommendation & ranking — research + algorithm

How Instagram decides **which Reel to show which person**, and **why some Reels
rise to the top** — researched from Meta's own public explanations (Adam Mosseri's
"Shedding light on how Instagram works" posts, the Reels ranking blog posts, and
Meta engineering writeups on multi-stage recommendation) — then adapted into an
algorithm Kaiveron can actually run on Postgres + Node (no ML infra, no Redis, per
project rules).

---

## Part 1 — How Instagram Reels actually works (deep research)

### 1. It's a recommendation problem, not a feed
The overwhelming majority of Reels a person sees are from **accounts they do NOT
follow**. So the core job is: from a pool of *millions* of recent reels, pick the
~dozen this specific person is most likely to enjoy *right now*. That is a
**recommendation/retrieval + ranking** problem, not chronological delivery.

### 2. The multi-stage funnel
You cannot score millions of candidates per user per refresh. Instagram (like
YouTube, TikTok, every large recommender) uses a **multi-stage funnel** that gets
progressively more expensive as the candidate set shrinks:

1. **Candidate sourcing / retrieval** (millions → a few thousand)
   Pull candidates from many sources: content similar to what you've engaged with,
   accounts similar to ones you like, trending/popular reels, topical clusters,
   fresh content needing a test audience. Implemented at scale with **two-tower
   embedding models** (a user tower + a content tower) and **approximate
   nearest-neighbor** retrieval, plus **collaborative filtering** ("people who
   engaged with what you did also engaged with X").

2. **First-stage ranking** (thousands → hundreds)
   A cheap model scores all candidates on lightweight features and keeps the best.

3. **Second-stage ranking** (hundreds → tens)
   A heavy neural net precisely predicts the probability you'll take each action.

4. **Final reranking / rules** (tens → the order you see)
   Diversity (don't stack the same author/topic/audio), integrity/quality filters,
   freshness, dedup (don't reshow seen reels), and combining all predictions into a
   single "value" score.

### 3. The signals — Mosseri's four buckets
Instagram frames ranking around four inputs, in roughly this order of importance
**for Reels**:

1. **Your activity** — what you've watched, liked, saved, shared, commented on.
   This builds your interest profile (which topics/creators/audio you like).
2. **Information about the reel** — popularity & engagement velocity, watch-through
   rate, audio track, visual quality, topic, recency.
3. **Information about the author** — how many people find their content
   interesting, how often *you* engage with them.
4. **Your history with that author** — direct affinity.

### 4. The predicted actions (the "value model") — Reels-specific
Instagram literally predicts probabilities of specific actions and combines them.
For Reels the heavily-weighted ones (Mosseri, stated publicly):

- **Watch time / completion / rewatch (loop)** — the single strongest Reels signal.
- **Likes**
- **Saves** — strong intent.
- **Sends / shares** (esp. DM sends) — Mosseri repeatedly calls sends very important.
- **Comments**
- "Likelihood you'll find it entertaining / interesting"
- "Likelihood you'll visit the audio page" (intent to re-create).

A reel's score ≈ a **weighted sum of these predicted probabilities**.

### 5. What makes a Reel "rise to the top" (virality / amplification)
There is no global static ranking — ranking is per-user. But a reel gains *reach*
through a **test-audience amplification loop**:

1. A newly posted reel is shown to a **small test audience** (cold-start).
2. Instagram measures **engagement-per-impression** — above all **watch-through
   rate** and **send/share rate**.
3. If it **beats expectations**, distribution **expands** to larger, similar
   audiences; the cycle repeats. This is how a small creator goes viral.
4. As the reel ages and its **engagement-per-impression decays**, amplification
   stops. So "what stays on top" = **sustained high engagement-rate × freshness**,
   not raw like totals.

### 6. What Instagram DOWN-ranks (quality / integrity)
Explicitly demoted: **reposted/aggregated content**, **visible watermarks** (e.g.
TikTok logos), **low-resolution / blurry**, borders, mostly-text overlays, muted
clips, engagement-bait, misinformation, and content from accounts that recently
violated policy. Original, high-quality, native content is favored.

### 7. Negative signals & exploration
- **Fast scroll-away / low watch time / "Not interested" / hide / report** →
  suppress that reel and similar ones.
- **Seen-but-not-engaged** → de-prioritize reshowing.
- **Exploration**: Instagram deliberately injects some unfamiliar creators/topics
  (ε-greedy style) to avoid filter bubbles and to give new content its test shot.

---

## Part 2 — Kaiveron "Shots Rank" (the algorithm we implement)

We can't run two-tower neural retrieval. But we can faithfully reproduce the
**shape**: multi-signal value scoring × freshness decay × personalization, with
diversity reranking and exploration — all in Postgres/Node. Signals available:
`Shot.viewCount`, `ShotView` (incl. `watchedMs`), `ShotLike`, `ShotSave`,
`ShotComment`, the `Follow` graph, and `Shot.animeId` (topic).

### Stage 1 — Candidate sourcing
Pool = non-deleted shots from the **last 45 days**, excluding ids the viewer has
already been served this session (carried in an opaque cursor). Cap to the most
recent ~300 for scoring cost. (Recency-bounded retrieval ≈ Instagram only ever
recommends fresh reels.)

### Stage 2 — Per-shot **value score** (the "value model")
For each candidate, `views = max(viewCount, likes+saves+comments, 1)` and:

- **Weighted engagement per view**, Bayesian-smoothed so low-sample shots aren't
  over/under-rated (same Wilson/shrink philosophy as the blog rank). Weights mirror
  Reels' action importance — **saves > comments > likes** (sends aren't tracked):
  `weightedEng = 1·likes + 3·comments + 5·saves`
  `engRate = (weightedEng + m·C) / (views + C)`  (C = prior strength, m = prior mean)
- **Watch-through multiplier** (the strongest Reels signal) when we have data:
  `wt = clamp(avgWatchedMs / durationMs, 0, 1.5)` → factor `(0.5 + wt)`
  (>1 ⇒ loops/rewatch). Neutral 1.0 when duration/watch data is missing.
- **Quality score** `= engRate · watchThrough`.

### Stage 3 — Freshness decay (gravity) + cold-start test boost
- **Gravity** (HN-style): `1 / (ageHours + 2)^1.2` — recent shots rank higher; old
  shots fade even if historically engaging (matches Reels' freshness bias).
- **Test-audience boost**: shots `< 48h` old AND with `views < THRESH` get a small
  multiplicative boost so brand-new content gets its cold-start shot (Stage-5 of
  the virality loop).

### Stage 4 — Personalization (per viewer)
Multiplicative affinity factors from the viewer's own graph + history:

- **Followed author** → ×1.6
- **Previously-engaged author** (viewer liked/saved their shots before) → ×1.3
- **Topic affinity** — shot's `animeId` ∈ anime the viewer engages with → ×1.3
- **Own shot** → ×0.3 (deprioritize, like IG rarely recommending you to yourself)

### Stage 5 — Integrity / quality filters (IG-style demotion)
- **Imported / reposted** (`sourceProvider != null`, our analog to watermarked
  reposts) → ×0.7
- **Missing thumbnail** (lower perceived quality) → ×0.9

`finalScore = quality · gravity · testBoost · personalization · integrity`

### Stage 6 — Final reranking (diversity + exploration)
- **Diversity**: never two consecutive shots from the same author; **max 2 per
  author per page**. (IG's "don't stack the same source".)
- **Exploration (ε-greedy)**: ~**20%** of each page is reserved for high-freshness,
  low-exposure shots regardless of score — anti-filter-bubble + cold-start.
- Take the top `limit` after reranking.

### Pagination
The page returns `meta.nextCursor` = an **opaque base64 token** of the shot ids
served so far (capped). The next request decodes it to **exclude** them from the
candidate pool. This keeps the existing cursor-passthrough client unchanged while
giving a stable, dedup-free ranked scroll. `nextCursor = null` when the pool is
exhausted.

### What this reproduces vs. real Instagram
| Instagram | Kaiveron Shots Rank |
|---|---|
| Two-tower ANN retrieval | Recency-bounded candidate pool + topic/author affinity |
| Heavy NN value model | Weighted, Bayesian-smoothed engagement-per-view |
| Watch-through prediction | `avgWatchedMs / durationMs` multiplier |
| Virality test-audience loop | Cold-start boost + engagement-rate × gravity |
| Diversity + integrity rerank | Per-author cap + repost/quality demotion |
| Exploration | ε-greedy fresh/low-exposure injection |
| Collaborative filtering | **Item-based co-engagement** (neighbors who liked/saved the same shots → their other shots) — retrieval source + score boost |
| Content embeddings | **Genre-cosine similarity** between the viewer's interest vector (onboarding + watchlist + engaged-shot genres) and each shot's anime genres |

### Advanced (hybrid recommender) — what `getRankedFeed` actually runs
The shipped ranker is a **hybrid recommender**, the tractable form of Instagram's
neural stack:

1. **Multi-source retrieval** — candidates are the union of (a) the recency pool
   and (b) **collaborative-filtering candidates**: shots engaged by the viewer's
   *neighbors* (users who co-liked/saved the same shots), which can surface
   relevant shots **outside** the recency window — real retrieval, not a re-sort.
2. **Content-based scoring** — a genre **interest vector** is built from the
   viewer's onboarding genres + watchlist (status-weighted) + engaged-shot genres,
   then each candidate is boosted by the **cosine similarity** of its anime's
   genres to that vector (`×(1 + 0.9·cos)`). This replaces the crude binary topic
   hit with a graded content match (the "content tower").
3. **Collaborative-filtering scoring** — each candidate is boosted by the
   normalized co-engagement weight of the viewer's neighbors (`×(1 + 1.0·cfNorm)`)
   — the "people like you also liked this" signal.
4. Steps 2–3 multiply the **value model × freshness × integrity** from above; then
   the same diversity + exploration rerank applies.

All of it is bounded Postgres queries (seed ≤ 80, neighbors ≤ 120, CF candidates ≤
150) + in-Node vector math — no vector DB, no Redis. The candidate-union step is
exactly where neural ANN retrieval would slot in at much larger scale without
touching the scoring/rerank stages.

### Why Postgres-only is enough at our scale
Per refresh: one `findMany` (pool ≤ 300) + one `ShotView` groupBy (watch stats) +
a few small set queries (follows, engaged authors/anime). All scoring is in Node.
No vector DB, no Redis, no queue. When the catalog grows, the candidate pool is the
natural place to bolt on ANN retrieval without changing the scoring/rerank stages.
