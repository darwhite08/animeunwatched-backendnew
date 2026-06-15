# Shots view counting — design

How we count "views" on Kaiveron Shots (the reels-style short-video feed), and
why. Grounded in how Instagram Reels and YouTube actually count, then adapted to
our stack (Postgres only — no Redis/queues, per project rule).

## How the incumbents count

### Instagram Reels (lenient — "plays")
- A **view = the reel started playing or replayed**, including plays under one
  second and loop replays. Meta unified the old "Plays" into "Views" (2024).
- Autoplay in-feed counts. Loops/replays increment. There is *no* watch-time gate.
- Surface metric is inflation-prone by design; Meta leans on bot filtering, not a
  duration threshold, to keep it honest.

### YouTube (strict — "qualified watch")
- A view = a **deliberate playback watched for a meaningful duration**. The widely
  cited bar is ~**30 seconds** (or the whole clip if shorter) for long-form.
- Heavy fraud detection: counts are throttled/"frozen" past ~300 while verified;
  replays count but are rate-limited; dedup heuristics per user/device/IP/window.
- **YouTube Shorts** is the exception — much closer to Reels: a view is counted
  when the Short **starts playing**, no fixed watch-time gate.

### Takeaway
Short-form (Reels / Shorts / TikTok) converges on **"it played"**, not "it was
watched for 30s." The honesty problem is then solved by **deduplication + bot
filtering**, not by a long watch threshold.

## Our model — Reels-leaning, dedup-protected

A view is counted when **all** of these hold:

1. **Qualification (client gate).** The shot accumulated **≥ 2s of real playback**,
   OR **≥ 50% of the clip** for clips shorter than 4s (whichever comes first).
   This is the short-form "it played" bar — stricter than IG's 0s so an
   accidental scroll-past doesn't count, far more lenient than YouTube's 30s.
   Embedded shots (TikTok/IG iframes — we can't read their playhead) qualify on a
   best-effort **2s active timer**.

2. **One per viewer per shot per UTC day (server dedup).** The counted unit is a
   unique `(shotId, viewer, day)`. Replays, loops, and refreshes within the same
   day are **no-ops** — they cannot inflate the count. A genuine return the next
   day counts again. This is the YouTube-style unique-per-window guard layered
   onto the Reels-style qualification.

3. **Not the author.** A creator watching their own shot never counts (YouTube/IG
   both discount the owner).

### Identity (the "viewer")
- Authenticated → `u:<userId>` (dedupes a logged-in user across devices).
- Anonymous → `a:<viewerKey>`, where `viewerKey` is a first-party random UUID
  persisted in `localStorage` (`kv_vk`). No fingerprinting.

### Why Postgres-only is enough
We do **not** hammer a hot counter on every play. The qualifying event is written
once to a `ShotView` ledger with a **unique constraint** on `(shotId, viewerKey,
day)`:

- Insert succeeds → first qualifying view today → atomically `viewCount += 1`.
- Insert hits the unique constraint (`P2002`) → already counted today → no-op.

Both happen in one short transaction. The unique index *is* the dedup + idempotency
mechanism, so no Redis set / queue is needed. `watchedMs` is stored alongside for
analytics and future fraud heuristics, but the **unique constraint** is what
protects the number.

## Data model

```prisma
model Shot {
  // ...
  viewCount Int        @default(0)   // denormalized, atomic increment
  views     ShotView[]
}

model ShotView {
  id        String   @id @default(cuid())
  shotId    String
  viewerKey String                 // "u:<userId>" | "a:<uuid>"
  userId    String?                // attribution (null for anon)
  day       String                 // "YYYY-MM-DD" (UTC bucket)
  watchedMs Int      @default(0)   // analytics / fraud signal
  createdAt DateTime @default(now())

  shot Shot @relation(fields: [shotId], references: [id], onDelete: Cascade)

  @@unique([shotId, viewerKey, day])  // ← dedup + idempotency
  @@index([shotId])
}
```

## API

`POST /api/v1/shots/:id/view`  (optionalAuth — anonymous allowed)

```jsonc
// body
{ "viewerKey": "<uuid from localStorage>", "watchedMs": 2140 }
// response
{ "viewCount": 1284, "counted": true }   // counted=false when deduped/self-view
```

- High-volume, lightweight: no Turnstile, no notifications, single transaction.
- `counted` lets the client know whether to bump its local number.

## Client flow (shots feed)

1. On mount, ensure a `kv_vk` UUID exists in `localStorage`.
2. While a reel is **active**, accumulate real playback time (`timeupdate` /
   active timer for embeds).
3. When the qualification bar is hit, fire `POST /shots/:id/view` **once per shot
   per page-session** (a ref guard), with `viewerKey` + `watchedMs`. The request
   carries the auth token when signed in (so the server can attribute + skip
   self-views).
4. Optimistically reflect `counted` in the on-screen view count.

## Abuse resistance summary
- Refresh / loop / replay spam → blocked by the per-day unique constraint.
- Scroll-past spam → blocked by the 2s qualification gate.
- Self-view inflation → skipped server-side.
- Anonymous multiplexing → bounded per device key; can be tightened later with
  per-IP rate limiting without changing the data model.
