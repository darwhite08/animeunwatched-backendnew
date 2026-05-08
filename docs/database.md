# Database

PostgreSQL 16. Prisma ORM. Schema lives in `prisma/schema.prisma`.

## Models (high level)

| Model                   | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| User                    | Identity, role, reputation, ban flag                      |
| RefreshToken            | Hashed refresh tokens for session rotation                |
| Anime                   | Local mirror of catalog data, sourced via CatalogProvider |
| Genre, Studio           | Reference tables                                          |
| AnimeGenre, AnimeStudio | Join tables                                               |
| ListEntry               | User's tracking entry for an anime                        |
| Follow                  | User-to-user follow                                       |
| Post, PostLike, PostComment | Twitter-style feed                                    |
| Club, ClubMember        | Sub-communities                                           |
| Thread, ThreadReply     | Reddit-style discussion (tree)                            |
| Review, ReviewLike      | Long-form opinion attached to anime                       |
| Blog                    | Long-form authored articles                               |
| Notification            | Persisted notifications                                   |
| Report                  | User-filed reports                                        |
| ModerationAction        | Audit log of mod/admin actions                            |

## Critical indexes

```sql
CREATE INDEX ON "Post" ("authorId", "createdAt");
CREATE INDEX ON "Post" ("createdAt");
CREATE INDEX ON "ListEntry" ("userId", "status");
CREATE INDEX ON "Thread" ("clubId", "createdAt");
CREATE INDEX ON "Thread" ("animeId", "createdAt");
CREATE INDEX ON "Review" ("animeId", "createdAt");
CREATE INDEX ON "Notification" ("recipientId", "createdAt");
CREATE INDEX ON "Report" ("status", "createdAt");
```

## Full-text search

Add as a follow-up migration after the initial schema:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE "Anime" ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce("titleEnglish",'')), 'A') ||
    setweight(to_tsvector('simple', coalesce("titleJapanese",'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(synopsis,'')), 'C')
  ) STORED;

CREATE INDEX anime_search_idx ON "Anime" USING GIN (search_vector);
CREATE INDEX anime_title_trgm ON "Anime" USING GIN (title gin_trgm_ops);
```

Repeat the pattern for `Post.content`, `Thread.title + body`, `Blog.title + body`, `User.username + displayName`.

## Migration discipline

- Every schema change is a Prisma migration: `npx prisma migrate dev --name <kebab-name>`
- Migrations are committed and reviewed
- `prisma migrate deploy` runs on backend container start in non-dev environments
- Never edit a generated migration after it has been merged to `main`. Add a new migration to fix issues.

## Migration log

Append a row whenever a migration is merged to `main`. Format:

| Date       | Name                | Notes              |
| ---------- | ------------------- | ------------------ |
| YYYY-MM-DD | init                | Schema baseline    |
| YYYY-MM-DD | add-fts-on-anime    | tsvector + pg_trgm |
| ...        | ...                 | ...                |

## Reset DB locally

```bash
npx prisma migrate reset
```

Drops, recreates, and re-runs all migrations. If `prisma/seed.ts` exists, seed runs automatically.

## Backup posture (prod)

- Daily logical backups (managed Postgres provider).
- 7 days hot retention, 30 days cold.
- Quarterly restore drill.
