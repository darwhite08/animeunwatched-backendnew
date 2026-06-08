# Kaiveron — "Trending Now" Algorithm (research-backed, low-strain)

> Rank the anime **being talked about most right now**, at **minimal server
> cost**, on our exact stack (Postgres + one in-process worker, **no Redis/
> Kafka/stream processor**). This version is grounded in a verified deep-research
> pass (23 primary-source claims confirmed 3-0; 2 refuted — noted in §11).

## TL;DR — the design the evidence converges on

A **three-layer** detector, each layer O(1)-per-update with **no history rescan**:

1. **Base signal — time-decayed velocity** via exponential/forward decay. The decayed count `D(t)=Σ exp(−λ(t−tᵢ))` advances by a single scalar multiply (`D ← D·e^(−λΔt) + new`) — "this result is virtually folklore" and runs at "similar space and time costs to non-decayed computation." This is the cheapest accurate base layer.
2. **Burst layer — O(1) recursive baselines.** Per-title **EWMA** mean/deviation + **robust-z** (and optional one-sided **CUSUM**) convert raw velocity into "is this *uncharacteristically* high for *this* title right now." Both are single-pass O(1)-state recursions — **no 28-day rescan.**
3. **Off-platform buzz (secondary)** — gathered only from **aggregate trending feeds + 1-unit list reads**, never per-title (external quotas forbid 30k per-title polls). Blended in for the candidate set.

Final ranking = smoothed blend, deseasonalized for the weekly airing pulse. Read path is one indexed `ORDER BY trendingScore` — zero external calls at request time.

---

## 1. Why this is the low-strain winner (verified)

| Technique | Cost | Verified source |
|---|---|---|
| Exponential decayed count | O(1)/event, no rescan; same cost as undecayed | Cormode/Korn/Tirthapura, *Exponentially Decayed Aggregates* (ICDE'09) |
| **Forward decay** (fixed per-event weight, normalize at read) | weights never recomputed as time passes; "same space/time bounds as undecayed… no system changes" | Cormode et al., *Forward Decay* (ICDE'09) |
| EWMA `zₜ=λxₜ+(1−λ)zₜ₋₁` + one-sided CUSUM `gₜ=[gₜ₋₁+Zₜ]₊` | O(1) time, O(1) state, single pass | Carvalho et al. (EWMA/CUSUM control charts) |
| Sketches (Count-Min/FDCMSS/HyperLogLog) | O(ln 1/δ)/item, memory independent of catalog size | FDCMSS (arXiv 1601.03892), Hokusai (arXiv 1210.4891) |

**Decision for 30k titles:** exact decayed counters/aggregates in Postgres are already cheap, so we do **not** need probabilistic sketches for the base counts — the research explicitly says sketches "may be overkill for a 30k-title catalog where exact decayed counters are already cheap; their value is specifically unique-user dedup and very high event volumes." We reserve **HyperLogLog only for unique-user dedup if `COUNT(DISTINCT user)` ever gets hot.**

---

## 2. Signals (what feeds the score)

**First-party (free, already in our Postgres — the dominant signal):** events that already carry `createdAt`:
`ListEntry` (adds/progress), `Post`/`Activity` (`animeId`/`linkedAnimeId`), `Review`, `Thread`+`ThreadReply` (`animeId`), likes/reposts.

**Off-platform buzz (secondary, candidate-only):** AniList `TRENDING_DESC` feed, Reddit r/anime hot JSON, optionally Google Trends (alpha, batch ≤5 terms) and YouTube **list** reads. See §6 for the hard quota math.

---

## 3. The engine — exact math

### 3a. Decayed velocity (base), computed without rescanning history
Half-life `h` (start at **h = 24h** → λ = ln2/h ≈ 0.0289/h) gives a "right-now" feel that fades a Sunday episode pulse by midweek. Two equivalent implementations — pick by event volume:

- **Default (low volume / simplest): windowed decayed aggregate on a cadence.** Decay is negligible beyond ~10·h, so only scan the last `W = 10·h ≈ 10 days`:
  ```sql
  SELECT "animeId",
         SUM(exp(-:lambda * EXTRACT(EPOCH FROM (now()-"createdAt"))/3600)) AS vel,
         COUNT(DISTINCT "userId")                                          AS uniq
  FROM "<signal>"
  WHERE "createdAt" > now() - interval '10 days'
  GROUP BY "animeId";
  ```
  One indexed range-aggregate per signal table. **No full-history scan** — bounded by a 10-day window.

- **Upgrade (high volume): incremental decayed counter.** One row per `(animeId, signal)` holding `{D, lastEventAt}`; per (batched) event: `D ← D·exp(−λ·Δt) + Σweights; lastEventAt ← t`. O(1), overflow-safe (backward-incremental form). Batch via the in-memory cache, flush every 60s — turns per-event DB writes into one bulk upsert.

Per-title velocity = weighted sum of its signals' `vel` (with unique-user dedup, §5).

### 3b. Burst — O(1) recursive baseline (replaces any baseline rescan)
Per title, store a tiny `TrendingState` (a handful of floats) updated **once per refresh**:
```
μ   ← (1−α)·μ   + α·v                 # EWMA mean of velocity     (α≈0.1)
dev ← (1−α)·dev + α·|v − μ|           # EWMA mean abs deviation
z   = (v − μ) / (1.4826·dev + ε)      # robust-z (MAD-scaled): Kleinberg "uncharacteristically frequent"
S   ← max(0, S + (z − k))             # one-sided CUSUM (k≈0.5), flags sustained buzz
burst = clamp(z, 0, Z_MAX) / Z_MAX    # 0..1   (Z_MAX≈8)
```
This is the crux of "least strain": the baseline is **never recomputed from history** — it's a 3-float recursion. (Optional upgrade: *budgeted online changepoint detection*, arXiv 2201.03710, "storage and per-observation compute independent of the number of previous observations" — only if ranking stability proves inadequate.)

### 3c. Deseasonalize the weekly airing pulse (the "open question" the research flagged)
Without this, **every Saturday-airing show trends every Saturday.** Fix: divide velocity by a **global day-of-week seasonal index** before the burst test, so "it's Saturday, everything's up" is removed and only *title-specific* spikes survive:
```
seasonIdx[d] = EWMA( mean velocity across ALL titles on weekday d ) / globalMean   # 7 floats, platform-wide
v_deseason   = v / seasonIdx[ weekday(now) ]
```
Run the burst test (3b) on `v_deseason`. Cost: 7 platform-wide floats, O(1).

### 3d. Final score
```
raw   = w_b·burst + w_v·norm(v_deseason) + w_e·norm(externalBuzz)      # weights below
score = raw · airingBoost · episodePulse
trendingScore ← β·score + (1−β)·prevScore     # EWMA smoothing, β≈0.5 → anti-flicker

weights:  w_b 0.55 (acceleration = "now")   w_v 0.25 (magnitude)   w_e 0.20 (off-platform)
boosts:   airingBoost 1.25 if airing        episodePulse 1.20 if an Episode.aired within h
norm():   p95-scaled to 0..1 so one signal can't dominate
```
`norm()` against a rolling p95 (one cheap percentile per refresh; t-digest if ever needed). **Relative** z-scoring already prevents perennial giants (One Piece) from permanently occupying the list — the research's Netflix lesson (normalize so big titles "don't get an advantage") is satisfied structurally, not by a runtime divisor.

---

## 4. Anti-gaming & cold-start (verified patterns)
- **Unique-user dedup:** score on `COUNT(DISTINCT userId)`, not raw events (one user can't spike a title). HyperLogLog only if that count gets expensive.
- **Per-user/day contribution cap** + ignore self-likes/no-op views (qualifying actions only).
- **Cold-start (new titles, no baseline):** until `dev` stabilizes, fall back to a **Wilson lower-bound / Bayesian-smoothed** velocity (shrink toward 0 with a prior) so a 2-event title can't top the chart on noise. (clux/decay ships Wilson + Reddit-Hot + HN-Hot ready-made for Express if we want a reference impl.)

---

## 5. Bounding the off-platform "deep search" (hard quota reality)
External APIs **cannot** be polled per-title at 30k scale (verified):
- **YouTube Data API:** 10,000 units/day; `search.list` = **100 units** (~100 calls/day) → per-title search would take ~300 days. `videos.list`/`channels.list`/`activities.list` = **1 unit**. → use **list reads only**, on candidates.
- **AniList GraphQL:** currently **30 req/min** (degraded; 90 normal). → one `Page(sort:TRENDING_DESC)` returns ~50 trending titles per call; a couple calls/hour is plenty.

So the collector is **candidate-gated + feed-based**:
1. Cheap first-party pass scores **all** titles (§3a SQL).
2. Candidates = top ~300 by first-party score ∪ currently-airing ∪ episode-aired-in-window.
3. Pull **aggregate trending feeds** (AniList trending, Reddit r/anime hot, optional Google Trends batch ≤5 terms) and map results onto candidate titles. Cache 1–12h.
External buzz is a **secondary blended signal**, never a per-title probe, never in the request path.

---

## 6. Where it runs (fits the stack, no new infra)
- **Schema:** `Anime.trendingScore Float? @default(0)`, `trendingRank Int?`, `trendingUpdatedAt`. New `TrendingState(animeId PK, ewmaMean, ewmaDev, cusum, prevScore, updatedAt)` (a few floats/title) + `TrendingSnapshot(animeId, score, components Json, createdAt)` for history + the "why trending" UI.
- **Job:** `compute-trending` on the existing **Postgres `SyncJob` queue**, drained by the in-process worker (register in `jobs/index.ts` beside `animeSyncWorker`). **Cadence: every 15–30 min** for first-party; **hourly** for the external candidate pass.
- **Collector:** `lib/buzz/` — one rate-limited client per source (reuse the `jikanClient` token-bucket), TTL-cached, failures → `SyncJobLog (jobType:"trending")`, each source behind an env flag (`TRENDING_ANILIST_ENABLED`, …) so it degrades to first-party-only when a key is missing.
- **API:** repoint the existing `GET /anime/trending` to `ORDER BY "trendingScore" DESC NULLS LAST` (indexed). The "Trending Now" tab already calls it. **100% from our DB at request time.**

---

## 7. Cost budget per refresh (why it's near-free)
- First-party: ~5 indexed windowed aggregates (bounded to last 10 days) → tens of ms.
- Burst/season: O(candidates) float recursions on a few floats each → microseconds.
- External: ≤ a handful of cached feed calls/hour, off the request path.
- Read: a single indexed `ORDER BY` — no compute at request time.
No per-event writes (default mode), no Redis, no history rescan, no per-title external calls. This is the minimum-strain point that still produces accurate, *relative*, deseasonalized, anti-gamed rankings.

---

## 8. Accuracy-per-compute ranking (from the research)
1. **Exponential/forward-decay velocity** — best base layer; accurate, essentially free vs undecayed.
2. **EWMA + robust-z (MAD)** — cheapest accurate burst flag; O(1) state.
3. **One-sided CUSUM** — adds sustained-shift sensitivity for ~free.
4. **Budgeted online changepoint (BOCPD-on-a-budget)** — highest stability, still constant per-obs; optional upgrade (authors' self-reported accuracy, not independently replicated — adopt only if needed).
5. **FDCMSS / Hokusai / Count-Min / HyperLogLog** — only for unique-user dedup or very high volume; overkill for 30k exact counts.
6. **EDCoW / Kleinberg full burst model** — for discovering *unknown* topics from raw text; heavier, unnecessary for ranking known catalog titles.

---

## 9. Rollout
1. **Phase 1 (ship first, zero external deps):** schema + `compute-trending` job with §3a decayed velocity + §3b EWMA/robust-z + §3c deseasonalization + unique-user dedup; repoint `/anime/trending`. Already beats `ORDER BY score`.
2. **Phase 2:** AniList trending + Reddit feeds as the blended `externalBuzz` (candidate-gated, cached).
3. **Phase 3:** CUSUM/BOCPD upgrade, "why trending" component breakdown in the UI, per-region trending, incremental-counter mode if event volume demands it.

---

## 10. Tuning defaults (start here, then measure)
`h=24h (λ=ln2/24)` · window `10 days` · EWMA `α=0.1` · smoothing `β=0.5` · `Z_MAX=8` · CUSUM `k=0.5` · weights `w_b .55 / w_v .25 / w_e .20` · refresh `20 min` / external `60 min`.

---

## 11. Honesty: what the research refuted / couldn't confirm
- **Refuted (not used here):** Reddit-Hot's "45,000s half-life" specific (0-3) and Netflix's "single-signal, Tue-publish" characterization (0-3). The design relies on neither.
- **Not independently verified:** the BOCPD-on-a-budget accuracy claim (authors' own benchmark) — treated as an *optional* upgrade, not the default.
- **No primary evidence gathered on:** exact Google Trends (alpha 2025) / Reddit / X costs, Kleinberg/BurstSketch/Page-Hinkley/t-digest specifics, and Spotify/Crunchyroll/Twitter internals — so external-buzz weighting is conservative and feed-based, and those signals are behind flags until measured.
