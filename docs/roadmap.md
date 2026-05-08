# Roadmap

Tied to `progress.md`. Order is a rough sequence; some phases overlap.

| Phase | Theme           | Headline deliverable                                | Est. weeks |
| ----- | --------------- | --------------------------------------------------- | ---------- |
| 0     | Bootstrap       | Hello-world API deployed, DB migrated               | 1          |
| 1     | Identity        | Register/login/refresh, profile read/edit           | 3          |
| 2     | Catalog         | Anime detail + seasonal + search via Jikan + cache  | 3          |
| 3     | Tracking        | Lists CRUD, public list view                        | 2          |
| 4     | Social v1       | Posts, follow, feed, discover, notifications + WS   | 3          |
| 5     | Community       | Clubs, threads, anime-scoped threads                | 3          |
| 6     | Long-form       | Reviews, blogs, full search                         | 2          |
| 7     | Moderation      | Reports, queue, mod actions, audit                  | 1          |
| 8     | Polish + launch | OpenAPI, metrics, Sentry, perf, DPDPA/GDPR endpoints | 2         |

Total: ~17 weeks for solo or small team. Apply 50% buffer.

## v1.1 candidates (post-launch)

- Email verification + password reset
- TOTP 2FA
- Image upload via signed S3/R2 URLs
- Episode discussion auto-creation cron
- Email digest for notifications
- Private clubs
- Comments on blogs
- MAL official provider (`src/lib/catalog/mal.provider.ts`)

## v2 candidates

- Native mobile API differences (if/when native apps ship)
- Meilisearch for relevance
- Recommendation engine (collab filtering on ListEntry)
- Streaming-link aggregation
- Multi-region read replicas
- Worker process for cron jobs (off the API process)
