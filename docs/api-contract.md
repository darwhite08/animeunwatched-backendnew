# API contract

Source of truth for both repos. The frontend repo's `docs/peer/backend-api-contract.md` is a copy of this file; whenever this file changes, copy it across.

## Conventions

- Base URL: `/api/v1`
- All requests/responses are JSON unless stated otherwise
- Authentication: `Authorization: Bearer <accessToken>` header
- Refresh: cookie `aw_refresh`, httpOnly, scoped to `/api/v1/auth`
- Error shape: `{ "error": { "code": "<UPPER_SNAKE>", "message": "string" } }`
- Pagination: `?page=1&limit=20`. Response: `{ data, meta: { total, page, limit, pages } }`
- Cursor pagination (feed): `?cursor=<opaque>&limit=20`. Response: `{ data, meta: { nextCursor } }`
- Times are ISO-8601 strings in UTC
- IDs are CUIDs (strings)

## Error codes

| Code         | HTTP | Meaning                             |
| ------------ | ---- | ----------------------------------- |
| VALIDATION   | 400  | Zod validation failed               |
| BAD_REQUEST  | 400  | Generic bad input                   |
| UNAUTHORIZED | 401  | Missing or invalid access token     |
| FORBIDDEN    | 403  | Authenticated but not allowed       |
| NOT_FOUND    | 404  | Resource does not exist             |
| CONFLICT     | 409  | Unique constraint or state conflict |
| RATE_LIMITED | 429  | Throttled                           |
| INTERNAL     | 500  | Unhandled                           |

## Endpoints

### Auth

#### POST /auth/register
Body: `{ email, username, displayName, password }`
201: `{ user, accessToken }` + sets `aw_refresh` cookie

#### POST /auth/login
Body: `{ email, password }`
200: `{ user, accessToken }` + sets `aw_refresh` cookie

#### POST /auth/refresh
Cookie: `aw_refresh`
200: `{ accessToken }` + rotates `aw_refresh`

#### POST /auth/logout
Auth: required
204: clears cookie

#### POST /auth/logout-all
Auth: required
204: revokes all refresh tokens for the user

#### GET /auth/me
Auth: required
200: `{ user }`

### Users

#### GET /users/:username
Auth: optional
200: `{ user, stats: { followers, following, listCount, reviewCount }, recentPosts, recentReviews }`

#### PATCH /users/me
Auth: required
Body: `{ displayName?, bio?, avatarUrl? }`
200: `{ user }`

#### POST /users/:username/follow
Auth: required
204

#### DELETE /users/:username/follow
Auth: required
204

#### GET /users/:username/followers, /following
Auth: optional
200: paginated `{ data: User[], meta }`

### Anime

#### GET /anime
Auth: optional
Query: `q?, year?, season?, genre?, type?, status?, page?, limit?`
200: paginated

#### GET /anime/:id
Auth: optional
200: `{ anime, listEntry? }` — `listEntry` present only when authenticated

#### GET /anime/season/:year/:season
Auth: optional
200: paginated

#### GET /anime/:id/threads
Auth: optional
200: paginated

#### GET /anime/:id/reviews
Auth: optional
Query: `sort=helpful|recent`
200: paginated

### Lists

#### GET /lists/:username
Auth: optional
Query: `status?, sort?`
200: paginated `{ data: ListEntry[] }`

#### PUT /lists/me/:animeId
Auth: required
Body: `{ status, score?, episodesSeen?, startedAt?, finishedAt?, notes? }`
200: `{ entry }`

#### DELETE /lists/me/:animeId
Auth: required
204

### Posts

#### GET /posts/feed
Auth: required
Query: `cursor?, limit?`
200: cursor-paginated

#### GET /posts/discover
Auth: optional
200: cursor-paginated

#### GET /posts/:id
Auth: optional
200: `{ post, liked? }`

#### POST /posts
Auth: required
Body: `{ content, animeId? }`
201: `{ post }`

#### DELETE /posts/:id
Auth: required (author or MOD/ADMIN)
204

#### POST /posts/:id/like, DELETE /posts/:id/like
Auth: required
204

#### GET /posts/:id/comments
Auth: optional
200: paginated

#### POST /posts/:id/comments
Auth: required
Body: `{ content }`
201: `{ comment }`

### Clubs

| Method | Path                      | Auth | Description               |
| ------ | ------------------------- | ---- | ------------------------- |
| GET    | /clubs                    | opt  | List clubs                |
| POST   | /clubs                    | ✓    | Create (reputation gated) |
| GET    | /clubs/:slug              | opt  | Detail                    |
| POST   | /clubs/:slug/join         | ✓    | Join                      |
| DELETE | /clubs/:slug/membership   | ✓    | Leave                     |
| PATCH  | /clubs/:slug/members/:uid | ✓    | Promote/demote (owner)    |

### Threads

| Method | Path                 | Auth | Description               |
| ------ | -------------------- | ---- | ------------------------- |
| GET    | /threads/:id         | opt  | Detail                    |
| POST   | /clubs/:slug/threads | ✓    | Create in club            |
| POST   | /anime/:id/threads   | ✓    | Create on anime           |
| PATCH  | /threads/:id         | ✓    | Pin/lock (mod)            |
| DELETE | /threads/:id         | ✓    | Author or mod             |
| GET    | /threads/:id/replies | opt  | Tree                      |
| POST   | /threads/:id/replies | ✓    | Reply (optional parentId) |

### Reviews

| Method | Path              | Auth | Description     |
| ------ | ----------------- | ---- | --------------- |
| POST   | /reviews          | ✓    | Create on anime |
| PATCH  | /reviews/:id      | ✓    | Author only     |
| DELETE | /reviews/:id      | ✓    | Author or mod   |
| POST   | /reviews/:id/like | ✓    | Like            |
| DELETE | /reviews/:id/like | ✓    | Unlike          |

### Blogs

| Method | Path         | Auth | Description          |
| ------ | ------------ | ---- | -------------------- |
| GET    | /blogs       | opt  | Paginated, published |
| POST   | /blogs       | ✓    | Create               |
| GET    | /blogs/:slug | opt  | Detail               |
| PATCH  | /blogs/:slug | ✓    | Author only          |
| DELETE | /blogs/:slug | ✓    | Author or mod        |

### Notifications

| Method | Path                        | Auth | Description   |
| ------ | --------------------------- | ---- | ------------- |
| GET    | /notifications              | ✓    | Paginated     |
| GET    | /notifications/unread-count | ✓    | `{ count }`   |
| PATCH  | /notifications/:id/read     | ✓    | Mark read     |
| PATCH  | /notifications/read-all     | ✓    | Mark all read |

### Search

#### GET /search
Query: `q (required), type=anime|posts|threads|users|blogs, page?, limit?`
200: paginated by type

### Moderation

| Method | Path                    | Auth | Description                  |
| ------ | ----------------------- | ---- | ---------------------------- |
| POST   | /moderation/reports     | ✓    | File a report                |
| GET    | /moderation/reports     | MOD+ | Queue                        |
| PATCH  | /moderation/reports/:id | MOD+ | Resolve/dismiss              |
| POST   | /moderation/actions     | MOD+ | Hide/delete/warn/suspend/ban |
| GET    | /moderation/actions     | MOD+ | Audit log                    |

## WebSocket

- URL: `/socket/v1` (Socket.io path)
- Auth: `auth: { token: <accessToken> }` on handshake
- Rooms: server joins `user:<userId>` automatically when authenticated
- Server → client events:

| Event              | Payload                                          |
| ------------------ | ------------------------------------------------ |
| `notification.new` | `{ id, type, payload, createdAt }`               |
| `post.liked`       | `{ postId, by: { id, username }, count }` (v1.1) |
| `thread.replied`   | `{ threadId, replyId }` (v1.1)                   |

## OpenAPI

The backend serves `/api/v1/openapi.json` for tooling. The frontend may generate types from this; the generated file lives in the frontend repo only.
