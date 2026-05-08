# Backend architecture

## Topology

```
┌────────────────────────┐
│ Next.js frontend       │  (separate repo)
│ animeunwatchedfrontend │
└─────────┬──────────────┘
          │ HTTPS REST + WSS
          ▼
┌────────────────────────────────────────────────┐
│ Express + Socket.io (this repo)                │
│ Port 4000                                      │
│                                                │
│  ┌────────────┐  ┌────────────┐                │
│  │ HTTP layer │  │ Socket.io  │                │
│  │ middleware │  │ rooms      │                │
│  └─────┬──────┘  └──────┬─────┘                │
│        │                │                      │
│        ▼                ▼                      │
│  ┌─────────────────────────────────┐           │
│  │ Module services (per domain)    │           │
│  │ auth, users, anime, lists,      │           │
│  │ posts, clubs, threads, reviews, │           │
│  │ blogs, notifications, search,   │           │
│  │ moderation                      │           │
│  └─────┬─────────────────────┬─────┘           │
│        │                     │                 │
│        ▼                     ▼                 │
│  ┌──────────────┐    ┌──────────────────┐      │
│  │ Prisma ORM   │    │ CatalogProvider  │      │
│  └──────┬───────┘    └────────┬─────────┘      │
└─────────┼─────────────────────┼────────────────┘
          ▼                     ▼
   ┌─────────────┐       ┌──────────────┐
   │ PostgreSQL  │       │ Jikan v4     │ (replaceable; see mock.md)
   └─────────────┘       └──────────────┘
```

## Layers

### 1. HTTP layer (`src/app.ts`, `src/middleware/`)

Helmet, CORS, JSON, cookie parser, morgan, error handler. Mounted under `/api/v1` via `src/routes.ts`.

### 2. Module layer (`src/modules/<domain>/`)

Each domain is one folder with four files:

- `*.routes.ts` — Express router, wires URLs → controller methods
- `*.controller.ts` — thin: parse, call service, respond
- `*.service.ts` — business rules, Prisma calls
- `*.schema.ts` — Zod request schemas

This layout repeats for every domain. **No cross-module Prisma calls.** Services that need data from another domain call that domain's service.

### 3. Persistence (`src/config/prisma.ts`, `prisma/schema.prisma`)

One Prisma client. Migrations in `prisma/migrations/`. Connection pooling left to Prisma defaults.

### 4. CatalogProvider abstraction (`src/lib/catalog/`)

Interface + Jikan implementation. The provider is the **only** code that talks to an upstream catalog source. Swapping Jikan for MAL official, AniList, or in-house data is a one-file change. See `mock.md`.

```
src/lib/catalog/
├── index.ts              ← exports the active provider via env CATALOG_PROVIDER
├── types.ts              ← CatalogAnime, CatalogSeason, CatalogProvider interface
├── jikan.provider.ts     ← current implementation
├── mal.provider.ts       ← TODO stub (v1.1)
└── anilist.provider.ts   ← TODO stub (v1.1)
```

### 5. Realtime (`src/realtime/socket.ts`)

Socket.io. JWT auth on handshake. Per-user rooms `user:<userId>`. Single helper `emitToUser`.

### 6. Background jobs (planned)

`src/jobs/` (v1.1+):

- `refreshTopAnime.cron.ts` — daily, refreshes top 500 anime via CatalogProvider
- `episodeDiscussion.cron.ts` — hourly, creates threads for newly aired episodes
- `cleanupRefreshTokens.cron.ts` — daily, deletes expired

`node-cron` in-process at v1; promote to a worker process at v2.

## Request lifecycle

```
HTTP request
   ↓
helmet, cors, body parse, cookie parse, morgan
   ↓
route → middleware chain (rateLimit, auth, validate)
   ↓
controller method
   ↓
service method (business rules, prisma, catalogProvider)
   ↓
JSON response
   ↓
errorHandler (catches HttpError, ZodError, default 500)
```

## Authorization model

Two layers:

1. **Site-level role** (`User.role`): `USER | MOD | ADMIN`.
2. **Club-level role** (`ClubMember.role`): `USER | MOD | ADMIN` scoped to one club.

Authorization checks live in services, not routes. Helper:

```ts
const canEditPost = (post, user) =>
  post.authorId === user.id || user.role === 'MOD' || user.role === 'ADMIN';
```

## Data flow: anime detail (cold path)

1. `GET /anime/:id` → `animeController.get`
2. `animeService.getById(id)` → Prisma `findUnique`
3. Not found OR `updatedAt < now() - 7d`:
   - `catalog.getAnimeByMalId(malId)` → Jikan
   - upsert into `Anime` + denormalize genres/studios
4. Return Prisma row (with caller's `ListEntry` joined if authenticated)

## Data flow: post + notification

1. `POST /posts` → `postsController.create`
2. `postsService.create(authorId, body)`:
   - Prisma create `Post`
   - parse `@mentions` from content
   - for each mentioned user: `notificationsService.create(...)`
3. `notificationsService.create`:
   - Prisma create `Notification`
   - `emitToUser(recipientId, 'notification.new', payload)`
4. Response: `201 { post }`

## Error model

Every error thrown is `HttpError` from `src/lib/errors.ts`. The global handler turns it into:

```json
{ "error": { "code": "...", "message": "..." } }
```

Zod errors become `code: "VALIDATION"` with `issues` attached.
