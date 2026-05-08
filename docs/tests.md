# Test catalog

## Frameworks

- Unit + integration: Vitest
- HTTP integration: Vitest + supertest
- Provider contract tests: Vitest with recorded fixtures (nock or msw-node)

## Coverage targets

- Services: 80% line, 90% branch on auth and catalog
- Controllers: smoke only (covered by integration)
- Lib helpers (jwt, password, errors, pagination, jikan provider): 95%

## Run

```bash
npm test                 # all
npm test -- --watch      # watch mode
npm run test:coverage    # report
npm run test:contract    # provider contract tests against active CATALOG_PROVIDER
```

## Per-module test plan (Kanban — same convention as progress.md)

### auth

#### Todo
- [ ] register: happy path
- [ ] register: duplicate email → CONFLICT
- [ ] register: duplicate username → CONFLICT
- [ ] register: weak password → VALIDATION
- [ ] login: happy path
- [ ] login: wrong password → UNAUTHORIZED
- [ ] login: banned user → UNAUTHORIZED
- [ ] login: unknown email → UNAUTHORIZED
- [ ] refresh: rotates token
- [ ] refresh: rejects expired
- [ ] refresh: rejects revoked
- [ ] refresh: family revocation on reuse
- [ ] logout: revokes specific token
- [ ] logout-all: revokes every refresh row for user

#### Doing

#### Done

### users

#### Todo
- [ ] getByUsername: returns counts and recent activity
- [ ] getByUsername: 404 unknown
- [ ] updateMe: updates allowed fields, ignores extras
- [ ] follow / unfollow: idempotent

#### Doing

#### Done

### catalog provider (Jikan)

#### Todo
- [ ] mapJikanToCatalog: covers every column with fixture
- [ ] rate limiter: enforces 2/sec
- [ ] retries on 429 with backoff
- [ ] returns null on 404
- [ ] handles malformed payload gracefully

#### Doing

#### Done

### anime service

#### Todo
- [ ] getById cold: calls provider, upserts, returns
- [ ] getById warm: does not call provider
- [ ] getById stale (updatedAt < 7d ago): calls provider, updates
- [ ] refresh does NOT touch ListEntry/Review rows
- [ ] getSeasonal: bulk upsert
- [ ] browse with filters: SQL composes correctly
- [ ] FTS query returns ranked results
- [ ] FTS typo tolerance (pg_trgm) returns near-match

#### Doing

#### Done

### lists

#### Todo
- [ ] upsert: insert path
- [ ] upsert: update path
- [ ] unique (userId, animeId) enforced
- [ ] remove

#### Doing

#### Done

### posts

#### Todo
- [ ] create with mentions → notifications
- [ ] like idempotent
- [ ] feed: only followed users
- [ ] feed: cursor pagination stable across writes
- [ ] discover: ranks by likes-in-24h
- [ ] delete: author OR mod
- [ ] delete: not author and not mod → FORBIDDEN

#### Doing

#### Done

### clubs

#### Todo
- [ ] create: reputation gate (< 10 → FORBIDDEN)
- [ ] join / leave
- [ ] role promotion: only owner
- [ ] private club access (v1.1)

#### Doing

#### Done

### threads

#### Todo
- [ ] create in club: must be member
- [ ] create on anime: any authenticated user
- [ ] reply tree: parentId resolves, depth correct
- [ ] pin/lock: club mod or site mod

#### Doing

#### Done

### reviews

#### Todo
- [ ] one per user-anime enforced
- [ ] like / unlike

#### Doing

#### Done

### blogs

#### Todo
- [ ] draft vs published visibility
- [ ] author-only edit

#### Doing

#### Done

### notifications

#### Todo
- [ ] persisted before emit
- [ ] unread-count
- [ ] mark read
- [ ] mark all read

#### Doing

#### Done

### search

#### Todo
- [ ] FTS ranking weights titles > body
- [ ] pg_trgm typo tolerance
- [ ] type-scoped query

#### Doing

#### Done

### moderation

#### Todo
- [ ] report rate-limited (5/min per user)
- [ ] queue requires MOD/ADMIN
- [ ] action writes ModerationAction row

#### Doing

#### Done

## Integration smoke

A single `tests/smoke.test.ts` runs end-to-end against a test database:

1. register → login → me
2. POST /anime/:id cold path (mocked provider)
3. PUT /lists/me/:animeId
4. POST /posts mentioning self
5. GET /notifications/unread-count → 1
6. socket.io receives `notification.new`

CI runs this on every PR.

## Provider contract test

`tests/catalog.contract.test.ts` runs the active provider against a fixture. Used to validate `swap.sh` swaps.

```bash
CATALOG_PROVIDER=jikan npm run test:contract
CATALOG_PROVIDER=mal npm run test:contract     # when implemented
```
