# Setup

For Claude Code on the command line. Every command is copy-paste-ready.

## Prereqs

- Node 22 LTS
- Docker Desktop
- A clone of this repo

## First time

```bash
cd animeunwatchedbackend
npm install
cp .env.example .env
# edit .env: set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET to 32+ random chars
# generate with: openssl rand -hex 32
docker compose up -d db
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

API is at `http://localhost:4000/api/v1`. Healthcheck: `curl http://localhost:4000/healthz`.

## Daily

```bash
docker compose up -d db
npm run dev
```

## After pulling main

```bash
npm install
npx prisma generate
npx prisma migrate dev   # applies any new migrations
```

## Reset DB

```bash
npx prisma migrate reset    # drops, recreates, re-runs migrations + seed
```

## Run tests

```bash
npm test
npm run test:coverage
npm run test:contract       # provider contract tests
```

## Swap catalog provider

```bash
./scripts/swap.sh jikan    # default
./scripts/swap.sh mal      # when implemented
./scripts/swap.sh anilist  # when implemented
```

See `mock.md` for full swap procedure.

## Build for production

```bash
npm run build
NODE_ENV=production npm start
```

## Docker

```bash
docker compose up --build
```

## Common Claude Code prompts

> "Read docs/architecture.md and docs/api-contract.md, then implement the auth module per docs/progress.md → Phase 1."

> "Read docs/mock.md before adding any code that calls Jikan."

> "Add an endpoint X. Update docs/api-contract.md, docs/progress.md, and docs/tests.md in the same change set."

> "Move the 'register endpoint' ticket from Doing to Done in docs/progress.md and docs/tests.md, append commit hash $(git rev-parse --short HEAD)."
