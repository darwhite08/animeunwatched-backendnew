# Conventions

## File naming

- Modules: `src/modules/<domain>/<domain>.<role>.ts` where role ∈ `routes | controller | service | schema`.
- Tests: colocated `*.test.ts` next to the file under test, OR under `tests/` for integration.
- Migrations: `prisma migrate dev --name <kebab-name>`.

## Code style

- TypeScript strict mode on. `any` is a code smell — use `unknown` and narrow.
- Zod for every controller input.
- Services return data, not Express responses.
- Throw `HttpError` from `src/lib/errors.ts` for any expected failure.
- No raw SQL except in migrations and FTS query helpers.
- Prisma client is a singleton from `src/config/prisma.ts`.
- No external HTTP outside `src/lib/catalog/` for upstream catalog data.

## Imports

- Absolute imports via `@/` alias from `src/`.
- Order: stdlib → third-party → `@/lib` → `@/modules` → relative.

## Commits

Conventional commits:

- `feat(auth): add logout-all endpoint`
- `fix(catalog): handle Jikan 429 with backoff`
- `chore(deps): bump prisma to 5.22`
- `docs(api): document /reviews/:id/like response`

Body: what changed and why. Footer: `Refs #ticket`.

## Branching

- `main` always deployable.
- Feature branches: `feat/<short-kebab>`. Squash on merge.
- Hotfix: `hotfix/<short-kebab>`, merge to main, tag, deploy.

## PR checklist

- [ ] Lint green (`npm run lint`)
- [ ] Typecheck green (`npx tsc --noEmit`)
- [ ] Tests added or updated
- [ ] `docs/api-contract.md` updated if endpoints changed
- [ ] `docs/progress.md` ticket moved to Done with commit hash
- [ ] `docs/mock.md` updated if Jikan touch points changed
- [ ] `docs/tests.md` updated if test plan changed
- [ ] `docs/database.md` migration log row added if schema changed

## Logging

- Pino. Log shape: `{ level, time, msg, ...context }`.
- No `console.log` in committed code.
- Don't log secrets, passwords, tokens, full email bodies.

## Error messages

- Public-facing message: short, actionable, no stack trace, no DB column names.
- Internal log: full context (userId, requestId, params).
