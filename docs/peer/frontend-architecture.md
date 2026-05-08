# (Mirror) Frontend architecture

**Read-only mirror of `animeunwatchedfrontend/docs/architecture.md`.**

Source of truth lives in the frontend repo. Do not edit here.

Last synced: 2026-05-08

To re-sync:

```bash
# from repo root
curl -fsSL https://raw.githubusercontent.com/darwhite08/animeunwatched-frontend/main/docs/architecture.md \
  -o docs/peer/frontend-architecture.md
# then update the "Last synced" line above to today's date and commit
```

---

(Contents follow on next sync. The frontend repo's `docs/architecture.md` describes:
- Next.js App Router page tree and routing strategy
- Server vs Client component split
- TanStack Query hydration patterns
- Tailwind + shadcn/ui design system
- Zustand stores
- API client (`lib/api/client.ts`) with refresh interceptor
- Socket.io singleton and how it surfaces notifications
- Form handling via React Hook Form + Zod
- Type strategy: DTOs are defined locally in `lib/api/types.ts`, optionally generated from the backend's OpenAPI spec, never imported from the backend repo.)
