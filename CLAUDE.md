# AnimeUnwatched — Backend CLAUDE.md

Repo: `animeunwatched-backend` | Peer: `animeunwatched-frontend`
Stack: Express 5 · TypeScript strict · Prisma ORM · PostgreSQL · Socket.io · argon2 · jsonwebtoken · Zod

**Read order on a fresh start:**
1. This file → `docs/architecture.md` → `docs/api-contract.md` → `docs/database.md` → `docs/progress.md`

---

## What this project is

The REST + WebSocket API backend for AnimeUnwatched — an anime social platform. Serves the Next.js frontend at `http://localhost:3000`. Single Express server on port 4000, Prisma ORM talking to PostgreSQL, Socket.io for real-time notifications.

---

## Folder layout

```
animeunwatched-backend/
├── app/
│   ├── app.ts                    ← Express app (CORS, middleware, route mounting)
│   ├── server.ts                 ← http.createServer + Socket.io init
│   └── src/
│       ├── config/
│       │   ├── env.ts            ← all env vars (PORT, JWT secrets, JIKAN_BASE_URL, etc.)
│       │   └── prisma.ts         ← singleton PrismaClient
│       ├── lib/
│       │   ├── errors.ts         ← HttpError + factory helpers (notFound, unauth, conflict…)
│       │   └── catalog/
│       │       ├── types.ts      ← CatalogAnime, CatalogProvider interfaces
│       │       ├── jikan.provider.ts ← Jikan v4 implementation with rate limiting
│       │       └── index.ts      ← exports active provider (env CATALOG_PROVIDER)
│       ├── middlewares/
│       │   ├── auth.middleware.ts     ← requireAuth, optionalAuth
│       │   ├── error.middleware.ts    ← global error handler
│       │   └── rateLimit.middleware.ts ← in-memory token bucket
│       ├── modules/              ← one folder per domain
│       │   ├── auth/             ← register/login/refresh/logout
│       │   ├── anime/            ← browse/getById/search/seasonal + Jikan fallback
│       │   ├── users/            ← profile/follow/update
│       │   ├── lists/            ← watchlist CRUD
│       │   ├── posts/            ← feed/discover/create/like/comments
│       │   ├── clubs/            ← club CRUD + join/leave
│       │   ├── threads/          ← thread CRUD + replies
│       │   ├── reviews/          ← per-anime reviews + like
│       │   ├── blogs/            ← long-form content
│       │   ├── notifications/    ← paginated + mark-read
│       │   └── search/           ← full-text across anime/posts/users/blogs
│       ├── realtime/
│       │   └── socket.ts         ← Socket.io setup, JWT auth, emitToUser helper
│       └── routes.ts             ← central router mounting all modules under /api/v1
├── prisma/
│   └── schema.prisma             ← 22 models (User, Anime, ListEntry, Post, Club, Thread…)
├── scripts/
│   ├── swap.sh                   ← swap catalog provider (jikan|mal|anilist)
│   └── seed.ts                   ← seed test users + anime + club (npx tsx scripts/seed.ts)
├── docker-compose.yml            ← postgres:16-alpine + app
├── Dockerfile
└── .env.example
```

---

## Module pattern

Every domain in `src/modules/<name>/` has exactly four files:
- `*.schema.ts` — Zod request validation schemas
- `*.service.ts` — business logic + Prisma calls
- `*.controller.ts` — thin HTTP handlers (parse → call service → respond)
- `*.routes.ts` — Express Router

**Never** make Prisma calls in a controller. **Never** cross-import between module services directly — call the other module's service function.

---

## API contract (`docs/api-contract.md`)

Base URL: `/api/v1`  
Auth: `Authorization: Bearer <accessToken>` header  
Errors: `{ error: { code: "UPPER_SNAKE", message: "string" } }`

Key endpoints built:
- `POST /auth/register|login|refresh|logout|logout-all` · `GET /auth/me`
- `GET /anime` · `GET /anime/:malId` · `GET /anime/search` · `GET /anime/season/:year/:season`
- `GET|PATCH /users/:username` · `POST|DELETE /users/:username/follow`
- `GET|PUT|DELETE /lists/me/:animeId` · `GET /lists/:username`
- `GET /posts/feed|discover` · `POST /posts` · `DELETE /posts/:id` · `POST|DELETE /posts/:id/like`
- `GET /clubs` · `POST /clubs` · `GET /clubs/:slug` · `POST /clubs/:slug/join`
- `GET|POST|DELETE /threads/:id` · `GET|POST /threads/:id/replies`
- `POST|PATCH|DELETE /reviews` · `POST|DELETE /reviews/:id/like`
- `GET|POST|PATCH|DELETE /blogs/:slug`
- `GET /notifications` · `GET /notifications/unread-count` · `PATCH /notifications/read-all`
- `GET /search?q=&type=anime|posts|users|blogs`

WebSocket: `/socket/v1` · JWT auth on handshake · per-user room `user:<id>` · event `notification.new`

---

## Database (`docs/database.md` + `prisma/schema.prisma`)

22 models across 6 domains. Key relations:
- `User` → `RefreshToken[]`, `Follow[]`, `ListEntry[]`, `Post[]`, `Club[]`, `Review[]`, `Blog[]`, `Notification[]`
- `Anime` → `Genre[]` (via AnimeGenre), `Studio[]` (via AnimeStudio), `ListEntry[]`, `Post[]`, `Thread[]`, `Review[]`
- `Post` → `PostLike[]`, `PostComment[]`
- `Club` → `ClubMember[]`, `Thread[]`
- `Thread` → `ThreadReply[]` (nested, parentId self-relation)

---

## Catalog provider (`docs/mock.md`)

Swap Jikan → AniList → MAL with one command:
```bash
./scripts/swap.sh <provider>   # jikan | mal | anilist
```
Or set `CATALOG_PROVIDER` env var. Every Jikan call goes through `src/lib/catalog/` — never fetch Jikan directly elsewhere.

---

## Progress (`docs/progress.md`)

All 9 modules implemented. When adding a new feature, move the ticket in `docs/progress.md` to Done with the commit hash. Update `docs/api-contract.md` if a new endpoint is added.

---

## Running locally

```bash
npm install
cp .env.example .env        # fill DATABASE_URL, JWT secrets
npx prisma migrate dev      # apply schema to DB
npm run seed                # seed test data (optional)
npm run dev                 # nodemon on port 4000
```

Or with Docker:
```bash
docker-compose up
```

---

## Strategy & Research Docs

These live at `../animeunwatched-docs/docs/` (sibling directory, not in this repo).
Read them before making architecture, scaling, or API design decisions.

| Doc | Path | When to read |
|---|---|---|
| **Master Strategy** | `strategy/animeunwatched-master-strategy.md` | Vision, monetisation model, phase milestones |
| **Platform Architecture** | `architecture/future-proof-platform-architecture.md` | Before any infra change — one backend, all surfaces, no rewrites |
| **Mobile Evolution** | `mobile-future/anime-mobile-evolution-strategy.md` | API design that works for web + future native apps |
| **Retention Engine** | `growth/anime-retention-engine.md` | Notification timing, streak mechanics, re-engagement endpoints |
| **Viral Growth Engine** | `growth/anime-viral-growth-engine.md` | Sharing endpoints, profile page SEO, public list APIs |
| **SEO Strategy** | `seo/anime-seo-growth-strategy.md` | Anime detail endpoints, structured data, sitemap generation |
| **Gamification Systems** | `gamification/anime-gamification-systems.md` | XP calculation, reputation system, badge triggers |
| **Social Systems** | `social/anime-social-platform-systems.md` | Feed algorithms, notification triggers, social graph design |
| **Competitor Analysis** | `research/anime-platform-competitor-analysis.md` | What API capabilities competitors lack — our differentiation |
| **Fan Psychology** | `psychology/viral-anime-fan-psychology.md` | Why certain data (lists, ratings) must be public and shareable |
| **Gen Z UX Research** | `ux/genz-anime-ux-research.md` | API response latency expectations, real-time requirements |

### Key architecture decisions from the strategy docs

**From `architecture/future-proof-platform-architecture.md`:**
- One backend serves web, iOS, Android, extensions — no per-client APIs
- JWT + refresh cookie is the auth model across all surfaces
- Socket.io rooms are per-user — never broadcast to all
- CatalogProvider abstraction must never be bypassed

**From `growth/anime-viral-growth-engine.md`:**
- Every User needs a public profile URL (`/u/:username`) — make it fast (SSR-able)
- Lists must be publicly readable (GET /lists/:username requires no auth)
- Season pages must be indexable — GET /anime/season/:year/:season returns full data

**From `gamification/anime-gamification-systems.md`:**
- Reputation += on: post created (+2), review posted (+5), review liked (+1), 7-day streak (+10)
- Reputation gates: create club requires 50+, apply for creator badge requires 200+
- XP and reputation are separate — XP is display, reputation is access control

**From `growth/anime-retention-engine.md`:**
- `notification.new` socket event must fire within 500ms of trigger
- Weekly streak reminder should be a scheduled job (cron) not real-time
- Episode discussion threads should auto-create when Jikan reports new episode aired

---

## Key constraints

- No Prisma calls outside `*.service.ts` files.
- No business logic in controllers — thin HTTP layer only.
- HttpError from `lib/errors.ts` for all error cases. Never `res.status(x).json(...)` directly.
- `catalog/` is the only place that calls Jikan. CI enforces this with grep check.
- Rate limits: global 100 req/min, auth routes 20 req/15min.
- Refresh tokens rotate on every use (delete old, create new).
