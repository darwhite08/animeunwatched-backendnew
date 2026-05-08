# Backend progress (Kanban)

Format: each phase has Todo / Doing / Done. Move tickets between sections as work progresses. When done, append the commit hash in parentheses, e.g. `- [x] register endpoint (a3f1b2c)`.

Update on every PR merge.

---

## Phase 0 — Bootstrap

### Todo
- [ ] Repo initialized with package.json, tsconfig, eslint, prettier
- [ ] docker-compose.yml for Postgres
- [ ] `.env.example` complete with CATALOG_PROVIDER
- [ ] CI workflow on GitHub Actions (lint, typecheck, build, test)
- [ ] First migration applied
- [ ] Healthcheck endpoint live

### Doing

### Done

---

## Phase 1 — Identity

### Todo
- [ ] User, RefreshToken Prisma models
- [ ] argon2 password helpers (`src/lib/password.ts`)
- [ ] JWT helpers (`src/lib/jwt.ts`): sign/verify access + refresh, hashToken
- [ ] auth.service: register, login, refresh, logout, logout-all
- [ ] auth.controller, auth.routes
- [ ] requireAuth, requireRole, optionalAuth middleware
- [ ] Rate limit on `/auth/*` (30 / 15 min)
- [ ] Refresh token reuse detection + family revocation
- [ ] users.service: getByUsername, updateMe, follow, unfollow
- [ ] users.controller, users.routes

### Doing

### Done

---

## Phase 2 — Catalog

### Todo
- [ ] Anime, Genre, Studio, AnimeGenre, AnimeStudio models
- [ ] CatalogProvider interface + types
- [ ] JikanProvider implementation with rate limiter
- [ ] mapJikanToCatalog field mapping
- [ ] anime.service: getById, getSeasonal, browse, refreshIfStale
- [ ] Cold-path persistence and TTL refresh (7d)
- [ ] FTS migration (search_vector, indexes, pg_trgm)
- [ ] anime.controller, anime.routes
- [ ] scripts/swap.sh + scripts/validateProvider.ts

### Doing

### Done

---

## Phase 3 — Tracking

### Todo
- [ ] ListEntry model + unique constraint (userId, animeId)
- [ ] lists.service: upsert, remove, getByUsername
- [ ] lists.controller, lists.routes

### Doing

### Done

---

## Phase 4 — Social v1

### Todo
- [ ] Post, PostLike, PostComment models
- [ ] Follow model
- [ ] posts.service: create, delete, like, unlike, comment, feed, discover
- [ ] @mention parser → notifications
- [ ] Cursor pagination helper
- [ ] Socket.io setup (`src/realtime/socket.ts`), JWT handshake
- [ ] notifications.service + emit
- [ ] notifications.controller, notifications.routes

### Doing

### Done

---

## Phase 5 — Community

### Todo
- [ ] Club, ClubMember models
- [ ] Thread, ThreadReply models
- [ ] clubs.service + routes (reputation gate on create)
- [ ] threads.service + routes (club + anime-scoped)
- [ ] In-club authorization helper

### Doing

### Done

---

## Phase 6 — Long-form

### Todo
- [ ] Review, ReviewLike models
- [ ] reviews.service + routes (unique per user-anime)
- [ ] Blog model
- [ ] blogs.service + routes (draft/published)
- [ ] Search FTS over Post, Thread, Blog, User
- [ ] search.service + routes

### Doing

### Done

---

## Phase 7 — Moderation

### Todo
- [ ] Report, ModerationAction models
- [ ] moderation.service + routes
- [ ] requireRole(MOD, ADMIN) on queue
- [ ] Audit log read endpoint

### Doing

### Done

---

## Phase 8 — Polish + launch

### Todo
- [ ] OpenAPI spec generator at `/api/v1/openapi.json`
- [ ] `/metrics` Prometheus endpoint
- [ ] Sentry SDK
- [ ] Data export endpoint (DPDPA/GDPR)
- [ ] Account deletion endpoint
- [ ] Performance pass (p95 < 250ms verified under load)
- [ ] swap.sh validated end-to-end
- [ ] CI on every PR runs full smoke test

### Doing

### Done

---

## Cross-cutting (continuous)

### Todo
- [ ] Keep `mock.md` table accurate on every Jikan touch addition
- [ ] Keep `api-contract.md` in sync with route changes
- [ ] Sync `docs/peer/*.md` whenever frontend updates corresponding doc
- [ ] Keep `tests.md` in sync with new test plans

### Doing

### Done
