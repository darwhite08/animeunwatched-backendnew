# User flows

For each flow: screens (frontend), API calls, DB writes, side effects. This is the doc that keeps the two repos honest.

## Flow 1 — Register and first session

| Step | Frontend                                  | API                   | Backend writes                                  |
| ---- | ----------------------------------------- | --------------------- | ----------------------------------------------- |
| 1    | `/register` form (Zod-validated)          | `POST /auth/register` | `User` insert; `RefreshToken` insert (hashed)   |
| 2    | Receive `{ user, accessToken }`           |                       |                                                 |
| 3    | Store access in memory; cookie set by API |                       |                                                 |
| 4    | Redirect to `/`                           | `GET /posts/discover` |                                                 |
| 5    | Connect Socket.io with access token       | (handshake)           | Server joins `user:<id>` room                   |

## Flow 2 — Browse → track an anime

| Step | Frontend                              | API                             | Backend                                                    |
| ---- | ------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| 1    | `/anime/season/2026/spring` page (SSR) | `GET /anime/season/2026/spring` | If cold, `catalog.getSeasonal()`, upsert each into `Anime` |
| 2    | Click a card → `/anime/:id`           | `GET /anime/:id`                | If cold/stale, `catalog.getAnimeByMalId`, upsert           |
| 3    | "Add to list" button → status select  | `PUT /lists/me/:animeId`        | Upsert `ListEntry`                                         |
| 4    | Optimistic update; toast on success   |                                 |                                                            |

## Flow 3 — Post + notification

| Step | Actor  | Frontend                       | API                  | Backend                                                                                                  |
| ---- | ------ | ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | User A | Compose post mentioning @B     | `POST /posts`        | Insert `Post`; parse mentions; insert `Notification(recipientId=B)`; emit `notification.new` to `user:B` |
| 2    | User B | Sees toast + nav badge bumps   |                      |                                                                                                          |
| 3    | User B | Opens notifications panel      | `GET /notifications` |                                                                                                          |
| 4    | User B | Clicks notification → post page | `GET /posts/:id`     |                                                                                                          |

## Flow 4 — Discussion thread in a club

| Step | Frontend              | API                         | Backend writes                                                                |
| ---- | --------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| 1    | Visit `/clubs/:slug`  | `GET /clubs/:slug`          |                                                                               |
| 2    | "Join"                | `POST /clubs/:slug/join`    | `ClubMember` insert                                                           |
| 3    | "New thread" form     | `POST /clubs/:slug/threads` | `Thread` insert                                                               |
| 4    | Other user replies    | `POST /threads/:id/replies` | `ThreadReply` insert; `Notification` to thread author and parent reply author |

## Flow 5 — Review on anime

| Step | Frontend                       | API                                   | Backend writes                              |
| ---- | ------------------------------ | ------------------------------------- | ------------------------------------------- |
| 1    | `/anime/:id` → "Write review"  |                                       |                                             |
| 2    | Submit                         | `POST /reviews`                       | `Review` insert (unique on userId+animeId)  |
| 3    | Visible on anime page          | `GET /anime/:id/reviews?sort=helpful` |                                             |

## Flow 6 — Search

| Step | Frontend                              | API                                    | Backend                                          |
| ---- | ------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| 1    | Type in search box, debounced 250ms   | `GET /search?q=&type=anime`            | Postgres FTS over local `Anime`                  |
| 2    | If empty, fallback button to upstream | `GET /search?q=&type=anime&upstream=1` | `catalog.searchAnime(q)`, upsert results, return |

## Flow 7 — Moderation

| Step | Actor | Frontend                  | API                                   | Backend                                  |
| ---- | ----- | ------------------------- | ------------------------------------- | ---------------------------------------- |
| 1    | User  | "Report" on a post        | `POST /moderation/reports`            | `Report` insert                          |
| 2    | Mod   | `/admin/moderation` queue | `GET /moderation/reports?status=OPEN` |                                          |
| 3    | Mod   | "Hide post"               | `POST /moderation/actions`            | `ModerationAction` insert; mutates target |

## Flow 8 — Refresh token rotation

| Step | Trigger                                  | Frontend                          | API                                | Backend                                                                                |
| ---- | ---------------------------------------- | --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | API call returns 401 with `UNAUTHORIZED` | API client interceptor catches it | `POST /auth/refresh` (cookie sent) | Verify refresh; if reuse → revoke family; rotate; respond with new access + new cookie |
| 2    | Retry original request                   |                                   | (replays the original)             |                                                                                        |
