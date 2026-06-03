# Kaiveron API — Style Guide

> The conventions every endpoint should follow. New endpoints that violate
> these get flagged in review. Existing endpoints that violate these are
> grandfathered until rewritten — don't rewrite for its own sake.

**Live spec:** `https://api.kaiveron.com/api/v1/openapi.json`
**Interactive explorer:** `https://api.kaiveron.com/docs`

---

## 1. URL structure

- **Base path:** `/api/v1`. Every public REST endpoint mounts under this.
- **Pluralised resource names:** `/posts`, `/users`, `/anime` (`anime` is the same singular + plural — accepted exception).
- **Sub-resources are nested:** `GET /clubs/:slug/members`, not `/clubMembers?clubSlug=…`.
- **Actions on a resource go on a sub-path:** `POST /posts/:id/like` (not `POST /likePost?id=…`). Verb in the path is OK when the action isn't a clean CRUD verb.
- **kebab-case for multi-word paths:** `/admin/api-keys`, `/posts/:id/not-interested`.
- **Path params: `:camelCase`** — `/users/:username`, `/posts/:postId`.
- **Query params: `camelCase`** — `?cursor=`, `?limit=`, `?sortBy=`.
- **Identifiers in paths**:
  - Internal cuids for posts, clubs, comments, etc. (`/posts/:id`)
  - Human-readable handles for users (`/users/:username`)
  - External canonical IDs for catalog entries (`/anime/:malId`)

## 2. HTTP methods

| Method | When |
|---|---|
| `GET` | Idempotent read. Never modifies state. |
| `POST` | Create OR a non-CRUD action (e.g. `POST /posts/:id/like`). |
| `PATCH` | Partial update. Body only carries the fields being changed. |
| `PUT` | Full replace. Rare — prefer PATCH. |
| `DELETE` | Soft-delete unless explicitly destructive. Returns 200/204. |

## 3. Status codes

| Code | Meaning |
|---|---|
| `200` | OK with body |
| `201` | Created with body |
| `204` | No content (DELETE success, logout, etc.) |
| `400` | Validation error — request body / params malformed |
| `401` | No / invalid auth |
| `403` | Authenticated but lacks permission OR step-up required |
| `404` | Resource doesn't exist (or actor can't see it) |
| `409` | Conflict — duplicate slug, already followed, already liked, etc. |
| `429` | Rate limited |
| `500` | Internal error (logged to Sentry) |

## 4. Response envelopes

Three canonical shapes — pick one per endpoint and stay consistent.

### a) Single resource

```json
{ "user": { "id": "...", "username": "..." } }
```

The wrapper key matches the resource singular. Useful when the response
might grow to include sibling fields later without breaking clients.

### b) Collection — offset paginated

```json
{
  "data": [ { ... }, { ... } ],
  "meta": { "total": 342, "page": 2, "limit": 20, "pages": 18 }
}
```

Use when the total count matters or random-page navigation is needed.

### c) Collection — cursor paginated

```json
{
  "data": [ { ... } ],
  "meta": { "nextCursor": "2026-06-03T10:24:11.012Z" }
}
```

Use for activity feeds, infinite scroll, anything time-ordered. `nextCursor`
is `null` when the end is reached.

### d) Algorithm-ranked collection

```json
{
  "data": [ { ... } ],
  "meta": {
    "algorithm": "trending-v2",
    "count": 20,
    "personalized": true
  }
}
```

Used by `/posts/trending`, `/anime/for-you`, `/users/suggestions`. Always
include the algorithm version string so clients can detect when the ranker
changes and refetch.

## 5. Error format

**Every** error response uses:

```json
{ "error": { "code": "UPPER_SNAKE_CODE", "message": "Human-readable" } }
```

Common codes: `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `RATE_LIMITED`, `INTERNAL`.

Never return `{ message: "..." }` or a raw string. Use the `HttpError`
factory in `lib/errors.ts` — `throw notFound("Post not found")` etc.

## 6. Authentication

Three states per route:

- **No auth** — public read endpoints (browse anime, public profile).
- **`requireAuth`** — most mutations + private reads.
- **`optionalAuth`** — public read that personalises if a token is present
  (e.g. `/anime/:malId` adds `isInMyList`, `/posts/discover` adds
  `isLikedByMe`).

Authentication = **bearer access token** in `Authorization: Bearer <jwt>`.
Refresh tokens live in an httpOnly cookie on the `.kaiveron.com` domain.

### Step-up

High-risk actions also require a short-lived step-up token from
`POST /admin/stepup`. Pattern:

```
PATCH /admin/content/posts/:id/score
Authorization: Bearer <jwt>
X-StepUp-Token: <token from /admin/stepup>
```

Middleware: `requirePermissionWithStepUp(resource, action)`. See
[`feedback_kaiveron_oauth_password_check`] memory for the OAuth-user gotcha.

## 7. Permissions (admin only)

Admin routes gate on `(resource, action)` pairs via:

- `requirePermission("users", "read")` — RBAC check only
- `requirePermissionWithStepUp("users", "role")` — RBAC + step-up

Every gated action writes an `AuditLog` row via `lib/adminAudit.ts`. The
log is a SHA-256 hash chain — append-only, no mutations from anywhere
else.

## 8. Pagination

- **Default `limit`**: 20.
- **Max `limit`**: 50 (most endpoints) or 100 (admin/list endpoints).
- **Offset:** `?page=N` (1-indexed) + `?limit=N`.
- **Cursor:** `?cursor=<opaque>` + `?limit=N`. The `nextCursor` value the
  server returned in the previous response, opaque to the client.

## 9. Filtering / sorting / sparse fields

- **Filtering** is per-resource — no generic filter DSL. Keep it explicit:
  `/anime?year=2024&season=fall&type=TV`.
- **Sorting:** `?sort=field` or `?sort=-field` for descending. Default sort
  is documented per endpoint. Don't bury defaults in mystery.
- **Sparse fields:** not currently supported. Don't add ad-hoc `?fields=…`
  unless we commit to the convention everywhere.

## 10. Rate limiting

Global: `200 req/min` per IP. Tighter per-endpoint where it matters:

- `POST /auth/login` — 10 / 15 min
- `POST /auth/register` — 10 / 15 min

Responses on a 429 include `Retry-After` (seconds). Don't retry without it.

## 11. Caching

API responses set `Cache-Control: no-store, no-cache, must-revalidate, private`
globally so per-user auth state never leaks across clients. Cache happens
**server-side** (in-memory `SimpleCache` keyed by query params, sometimes
also by viewer id). TTLs are visible per endpoint — see service files.

## 12. Idempotency

Mutations that should be safe to retry (likes, hides, list upserts) use
`upsert` server-side so the same request twice is a no-op. We do not yet
support an `Idempotency-Key` header — clients should make individual
mutations idempotent at the resource level instead.

## 13. Realtime

Socket.io at `/socket/v1`. JWT auth on handshake. Per-user room
`user:<id>`. Event names follow `<resource>.<verb>` — `notification.new`,
`post.created`, `presence.online`, etc.

## 14. Versioning

- Current version: **v1**, mounted at `/api/v1`.
- We will introduce **v2** as a parallel mount when v1 reaches a breaking
  change we can't defer. v1 stays serving for a minimum 90 days after v2
  GA, with `Sunset:` + `Deprecation:` headers on every v1 response during
  the cutover window (already wired via the `deprecation.middleware`).
- **Never** silently break v1 in place. Add fields, never remove.

## 15. New endpoint checklist

Before merging a new route:

- [ ] Mounted under `/api/v1` (or `/admin/...` inside `adminRouter`).
- [ ] Uses one of the canonical envelopes (§4).
- [ ] Errors via `HttpError` factories (§5).
- [ ] Auth middleware selected: `requireAuth` / `optionalAuth` / `requirePermission*`.
- [ ] Rate-limit reasonable (default global limit is usually fine).
- [ ] Documented via `docRoute(method, path, { … })` if it differs from
      the auto-generated entry (response shape, body schema, parameters).
- [ ] At least one test (`tests/<module>.test.ts`).
- [ ] OpenAPI entry visible at `/docs` after restart.
