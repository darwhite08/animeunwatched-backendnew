# Backend docs index

Repo: https://github.com/darwhite08/animeunwatched-backendnew.git
Folder: `animeunwatchedbackend`
Peer repo: https://github.com/darwhite08/animeunwatched-frontend.git (`animeunwatchedfrontend`)

There is **no shared code** between the two repos. The contract between them is the API at `/api/v1` and the WebSocket at `/socket/v1`, both versioned.

## Read order (fresh start)

1. `requirements.md` — what we're building (backend slice)
2. `architecture.md` — how the backend is structured
3. `database.md` — schema and migrations
4. `api-contract.md` — REST + WebSocket surface (this is the contract the frontend builds against)
5. `mock.md` — Jikan integration and how to swap it later
6. `flows.md` — how user journeys map to API calls and DB writes
7. `setup.md` — get the repo running locally
8. `conventions.md` — code conventions
9. `runbook.md` — operational procedures
10. `roadmap.md` and `progress.md` — what's done, what's next
11. `tests.md` — what's tested
12. `glossary.md` — terms

## Cross-repo visibility

Read-only mirrors of the frontend's relevant docs live in `docs/peer/`:

- `peer/frontend-architecture.md`
- `peer/frontend-api-client.md`

**Never edit `docs/peer/*` from this repo.** They're synced manually when the frontend's docs change. The frontend repo has the same arrangement in reverse, mirroring this repo's `architecture.md` and `api-contract.md`.

## Working with Claude Code

Recommended starting prompt when you `cd` into this repo:

> "Read docs/README.md, docs/architecture.md, docs/api-contract.md, and docs/progress.md. Then tell me what to do next."

For Jikan-related work:

> "Read docs/mock.md before touching anything in src/lib/catalog/ or src/modules/anime/."

For new endpoints:

> "Add endpoint X. Update docs/api-contract.md, docs/progress.md, and docs/tests.md in the same change set."
