# Kaiveron — "Trending Now" Algorithm

> Goal: rank the anime **being talked about the most right now**, blending our
> own first-party engagement velocity with off-platform web buzz (Google
> Trends, Reddit, news). Computed by a background worker, stored on the row,
> read instantly by the `/bestanimelist` "Trending Now" tab.

This is grounded in how production systems do it:
- **Kleinberg burst detection** — a topic is "trending" when it is *uncharacteristically frequent* vs its own normal, then decays.
- **Velocity / acceleration** — maintain two time windows, measure the *rate of change*, not the raw count.
- **Hacker News gravity** — `score = (P−1)/(T+2)^1.8`: time-decay so nothing stays hot forever.
- **Reddit hot** — `log10(votes) + t/45000`: log-dampened magnitude + additive time.
- **AniList trending** — rolling-window recent activity volume.

The core idea Kaiveron adopts: **trending = baseline-normalized, time-decayed acceleration across multiple signals.** Raw popularity (One Piece always has volume) is explicitly *not* trending; a sudden spike relative to a title's own baseline *is*.

---

## 1. Signals

For each anime we gather event counts in two windows:
- **Now window** `W` = last **48h** (the "is it hot right now" window).
- **Baseline window** `B` = the **28 days before W** (the title's normal rate).

### 1a. First-party signals (free, real-time — already in our Postgres)
These need zero external APIs and update the instant a user acts.

| Signal | Source table | What it captures |
|---|---|---|
| `s_list`   | `ListEntry` (createdAt/updatedAt) | watchlist adds + status changes |
| `s_post`   | `Post` / `Activity` where `animeId`/`linkedAnimeId` | feed mentions |
| `s_review` | `Review` (createdAt)              | new reviews |
| `s_thread` | `Thread` + `ThreadReply` where `animeId` | discussion volume |
| `s_engage` | `PostLike` / `ActivityLike` / `ActivityRepost` on the above | downstream engagement |

### 1b. Web-buzz signals (the "deep search" — off-platform, what people talk about elsewhere)
Fetched by a **rate-limited collector** (reuse the `jikanClient` token-bucket pattern) only for a **bounded candidate set** (see §5), so we never call these for all 30k titles.

| Signal | Source | Access notes |
|---|---|---|
| `g_trends` | **Google Trends API** (alpha, 2025) — search interest 0–100 + Δ vs prior period | request alpha access; fallback: unofficial `serpapi`/`hasdata` providers, or skip |
| `r_reddit` | **Reddit API** — mention/comment velocity in r/anime + the show's own subreddit | OAuth app, ~60 req/min; search `?q=title&sort=new&t=week` |
| `n_news`   | News/RSS mention count (optional) — e.g. ANN, Crunchyroll news | RSS, cheap |
| `y_youtube`| YouTube Data API — recent upload/comment velocity for the title (optional) | quota-limited |

Each web signal is stored with a fetch timestamp and TTL-cached (6–12h) so a refresh cycle reuses recent pulls.

---

## 2. Per-signal trend score (burst + magnitude)

For each signal `i`, compute two things from the windows.

**Time-decayed counts.** Instead of a flat count in `W`, weight each event by recency so a spike in the last 6h beats one 40h ago (exponential decay, cleaner than HN's polynomial for event streams):

```
half_life   = 18h
λ           = ln(2) / half_life
decayedCount(W) = Σ_events exp(−λ · age_hours(event))
```

**Baseline rate + spread** from `B`:
```
μ_i = mean daily decayedCount over B
σ_i = stddev of daily decayedCount over B
```

**Burst (Kleinberg / z-score)** — how abnormal is right-now vs this title's own normal:
```
rate_now_i = decayedCount(W) / (W in days)        # = per-day rate in the now-window
z_i        = (rate_now_i − μ_i) / (σ_i + ε)       # ε avoids div-by-zero for quiet titles
burst_i    = clamp(z_i, 0, Z_MAX)                 # Z_MAX ≈ 8; negatives aren't "trending"
```

**Magnitude (Reddit-style log dampening)** — so a brand-new mega-hit with no baseline still ranks, and so absolute size matters a little:
```
mag_i = log10(1 + decayedCount(W))
```

**Per-signal score** blends acceleration and size, favoring acceleration (that's what "now" means):
```
α        = 0.65                                   # acceleration weight
signal_i = α · (burst_i / Z_MAX) + (1 − α) · normalize(mag_i)
```
(`normalize` maps mag into 0..1 against a rolling p95 so one signal can't dwarf the rest.)

---

## 3. Weighted blend across signals

```
weights w_i (trust × off-platform reach):
  s_list   0.22    # strong intent signal
  s_post   0.15
  s_review 0.10
  s_thread 0.13
  s_engage 0.10
  g_trends 0.18    # broad real-world interest
  r_reddit 0.10
  n_news   0.02

blend = Σ_i w_i · signal_i          # weights sum to 1
```

---

## 4. Boosts, smoothing, anti-gaming

```
# Airing & new-episode pulse — what people discuss "now" skews to current shows
airingBoost   = 1.25 if status airing else 1.0
episodePulse  = 1.20 if an Episode.aired falls inside W else 1.0

raw = blend · airingBoost · episodePulse

# Anti-gaming: cap any single user's contribution per signal (brigade-proofing),
# and require a minimum total event volume so noise can't top the chart.
if totalEvents(W) < MIN_VOLUME (e.g. 5):  raw = 0

# Temporal smoothing (EWMA) so the list doesn't flicker between refreshes:
trendingScore_t = β · raw + (1 − β) · trendingScore_{t−1}      # β = 0.5
```

`trendingScore` is the final value the tab orders by. A `trendingRank` and the
component breakdown are stored too (for the UI's "why is this trending" and for
debugging).

---

## 5. Bounding external API cost (the practical crux)

We cannot hit Google Trends / Reddit for 30k anime hourly. So the collector is
**candidate-gated**:

1. **Cheap pass (all anime):** compute first-party `blend` from pure SQL — fast, free.
2. **Candidate set:** take `top ~300 by first-party blend` ∪ `all currently-airing` ∪ `titles with an episode aired in W`.
3. **Expensive pass (candidates only):** fetch `g_trends` / `r_reddit` for that bounded set, respecting each API's rate limit (token bucket).
4. Blend, smooth, store. Everything outside the candidate set keeps first-party-only scores (decayed toward 0).

This focuses web research exactly where there's already momentum, and keeps external calls in the low hundreds per cycle.

---

## 6. Where it runs (fits Kaiveron's existing stack)

No new infra — mirror the anime-sync design:

- **Schema:** add to `Anime`: `trendingScore Float? @default(0)`, `trendingRank Int?`, `trendingUpdatedAt DateTime?`. Add a `TrendingSnapshot` table `(animeId, score, components Json, window, createdAt)` for history + the "why trending" UI.
- **Job:** `compute-trending` enqueued on the existing Postgres `SyncJob` queue, run **every 30–60 min** by the in-process worker (register in `jobs/index.ts` like `animeSyncWorker`). Two stages: SQL first-party pass → candidate-gated web-buzz pass.
- **Collector:** `lib/buzz/` with one rate-limited client per source (token bucket like `jikanClient`), TTL-cached results, failures logged to `SyncJobLog` (`jobType: "trending"`). Each source is independently disableable via env (`TRENDING_GOOGLE_ENABLED`, `TRENDING_REDDIT_ENABLED`) so we degrade gracefully to first-party-only when an API key is missing.
- **API:** repoint the existing `GET /anime/trending` (`getTrending`) to `ORDER BY trendingScore DESC NULLS LAST` instead of `score`. The "Trending Now" tab already calls it.
- **Read path:** entirely from our DB (one indexed `ORDER BY trendingScore` query) — no external call at request time, consistent with the listing being Postgres-only.

---

## 7. Reference pseudocode

```ts
async function computeTrending() {
  const W = hours(48), B = days(28), now = Date.now()
  const decay = (t: Date) => Math.exp(-Math.LN2 / 18 * (now - t.getTime()) / 3.6e6)

  // 1. First-party pass — SQL aggregations per anime over W and B.
  //    (events carry timestamps so we can apply `decay` in JS or a SQL
  //    exp() expression.)
  const firstParty = await aggregateFirstPartySignals(W, B)   // Map<animeId, {signal_i}>

  // 2. Candidate gate
  const candidates = pickCandidates(firstParty, {
    topN: 300, includeAiring: true, includeEpisodeAiredIn: W,
  })

  // 3. Web-buzz pass — bounded, rate-limited, cached
  const buzz = await collectWebBuzz(candidates)   // Map<animeId, {g_trends, r_reddit, n_news}>

  // 4. Blend + boost + smooth + persist
  for (const animeId of allScoredIds(firstParty, buzz)) {
    const sig   = perSignalScores(firstParty.get(animeId), buzz.get(animeId)) // §2
    const blend = weightedBlend(sig, WEIGHTS)                                  // §3
    const raw   = applyBoostsAndFloor(blend, animeId, W)                       // §4
    const prev  = await getPrevTrendingScore(animeId)
    const score = 0.5 * raw + 0.5 * (prev ?? 0)                                // EWMA
    await upsertTrendingScore(animeId, score, sig)                             // Anime + snapshot
  }
  await recomputeTrendingRanks()   // dense rank by score desc
}
```

---

## 8. Why this is correct for "talked about most *right now*"

- **Acceleration over volume** (z-score baseline) surfaces the show that *just* spiked, not the eternal top-100.
- **Time decay** (18h half-life) means a Sunday episode drop fades by midweek unless buzz sustains.
- **Multi-signal blend** means a title trends whether the spike is on *our* feed (list adds, threads) or *off-platform* (Google searches, Reddit) — catching trailers, controversies, finales that haven't hit our feed yet.
- **EWMA smoothing + volume floor** keep it stable and noise-resistant.
- **Candidate gating** makes the web "deep search" affordable at 30k-title scale.

---

## 9. Rollout phases

1. **Phase 1 (ship first, zero external deps):** first-party signals only. Already enough to beat the current `ORDER BY score`. Add schema + `compute-trending` job + repoint `/anime/trending`.
2. **Phase 2:** add Google Trends collector (biggest off-platform signal) behind a flag.
3. **Phase 3:** add Reddit (+ optional news/YouTube), the "why trending" component breakdown in the UI, and per-region trending.
