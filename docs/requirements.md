# Backend requirements

Backend slice of the full product requirements. The complete cross-cutting requirements doc was authored separately; this file is the version of record for what the backend must implement.

## Scope

The backend is the **only** producer of:

- User identity, sessions, JWT tokens
- Anime catalog (sourced from Jikan, persisted locally — see `mock.md`)
- Tracking lists, posts, clubs, threads, reviews, blogs, follows
- Notifications (persisted + WebSocket-emitted)
- Search (Postgres FTS over local data)
- Moderation queue and actions
- Reputation calculation

The backend is **not** responsible for any UI concern, SSR, image optimization, or frontend routing.

## Functional requirements

Reference: full numbered list lives in the requirements doc at the repo root. Below is the backend-impacting subset, with backend-specific detail. RFC 2119: **MUST** = v1; **SHOULD** = v1 if time allows; **MAY** = post-v1.

### F-1 Identity

- F-1.1 `POST /auth/register` accepts email, username, displayName, password. Creates `User`, hashes with argon2id.
- F-1.2 Username regex `/^[a-zA-Z0-9_]{3,24}$/`. Email RFC-5322 via Zod.
- F-1.4 Argon2id params: `t=3, m=64MB, p=4`.
- F-1.5 Access JWT 15m HS256. Refresh JWT 30d HS256, rotated on every `/auth/refresh`. Stored hashed (SHA-256) in `RefreshToken`.
- F-1.6 `POST /auth/logout` revokes the refresh row matching the cookie's hash.
- F-1.7 `POST /auth/logout-all` revokes every non-revoked refresh row for `user.id`.
- F-1.8 Refresh reuse detection: if a refresh hits a row already marked `revokedAt`, revoke the entire family for that user.

### F-2 Profile

- F-2.1 `GET /users/:username` is publicly readable; returns counts and recent activity (last 10 posts, last 5 reviews).
- F-2.2 `PATCH /users/me` accepts `displayName`, `bio`, `avatarUrl`.

### F-3 Catalog

- F-3.1 First request for an unseen `malId` triggers a Jikan fetch + persist. See `mock.md`.
- F-3.2 `GET /anime/:id` returns local row; lazy-refresh if `updatedAt < now() - 7 days`.
- F-3.3 `GET /anime?year=&season=&genre=&type=&status=` paginated.
- F-3.4 `GET /anime?q=` Postgres FTS over `title`, `titleEnglish`, `titleJapanese` with `pg_trgm` typo tolerance.
- F-3.5 `GET /anime/:id` includes the caller's `ListEntry` if authenticated.

### F-4 Lists

- F-4.1 `PUT /lists/me/:animeId` upserts. `DELETE /lists/me/:animeId` removes.
- F-4.2 Unique `(userId, animeId)` constraint on `ListEntry`.
- F-4.3 `GET /lists/:username?status=&sort=` filters and sorts.

### F-5 Posts

- F-5.1 `POST /posts` with content ≤ 2000 chars, optional `animeId`.
- F-5.3 `POST /posts/:id/like`, `POST /posts/:id/comments`.
- F-5.4 `GET /posts/feed` returns posts where `authorId IN (followed_users)`, cursor-paginated.
- F-5.5 `GET /posts/discover` returns posts with most likes in last 24h.
- F-5.6 v1.1: signed S3/R2 upload URL endpoint.

### F-6 Clubs

- F-6.1 `POST /clubs` requires `user.reputation >= 10`. Slug unique.
- F-6.2 `ClubMember.role IN (USER, MOD, ADMIN)` for in-club authorization.
- F-6.4 `POST /clubs/:slug/join`, `DELETE /clubs/:slug/membership`.

### F-7 Threads

- F-7.1 `POST /clubs/:slug/threads` or `POST /anime/:id/threads`.
- F-7.2 `ThreadReply.parentId` self-references for tree.
- F-7.5 `PATCH /threads/:id { pinned, locked }` — club mod or site mod.

### F-8 Reviews

- F-8.1 Unique `(userId, animeId)` on `Review`.
- F-8.2 `rating: 1..10`, optional `title`, `body`, `hasSpoilers`.

### F-9 Blogs

- F-9.1 `POST /blogs`, `PATCH /blogs/:slug`, `published` flag.

### F-10 Follow

- F-10.1 `POST /users/:username/follow`. Idempotent.
- F-10.3 Feed cursor: `(createdAt, id)` opaque base64.

### F-11 Notifications

- F-11.1 `Notification` row written, then `emitToUser(recipientId, 'notification.new', payload)`.
- F-11.3 `GET /notifications/unread-count`.

### F-12 Search

- F-12.1 `GET /search?q=&type=anime|posts|threads|users|blogs`.
- F-12.2 Per-type Postgres FTS with weighting (titles A, body B).

### F-13 Moderation

- F-13.1 `POST /moderation/reports`.
- F-13.2 `GET /moderation/reports?status=OPEN` — MOD/ADMIN.
- F-13.3 Every action writes `ModerationAction`.

### F-14 Episode discussions

v1.1: cron worker reads airing schedule from Jikan, creates a thread on the anime page when a new episode airs.

## Non-functional

| ID  | Requirement                                                   |
| --- | ------------------------------------------------------------- |
| N-1 | p95 < 250 ms for read endpoints under 100 RPS                 |
| N-3 | 99.9% monthly availability                                    |
| N-4 | Architected for 100k MAU at v1, 1M at v2 without rewrite      |
| N-5 | OWASP ASVS L1 baseline                                        |
| N-6 | DPDPA + GDPR data export and deletion endpoints               |

## Out of scope (backend)

- Image optimization, SSR, sitemap generation (frontend concerns)
- GraphQL
- Native mobile API differences (PWA only at v1)
