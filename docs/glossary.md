# Glossary

- **AccessToken** — short-lived (15m) JWT in `Authorization` header.
- **RefreshToken** — long-lived (30d) JWT in httpOnly cookie, rotated on use, hashed in DB.
- **CatalogProvider** — interface in `src/lib/catalog/types.ts`. Active implementation is selected by `CATALOG_PROVIDER` env. See `mock.md`.
- **Cold path** — first-time fetch of upstream data; populates local cache.
- **Warm path** — subsequent fetch served from local DB.
- **Stale** — `Anime.updatedAt < now() - 7d`. Triggers async re-fetch on next read.
- **Reputation** — internal user-trust score. Gates club creation and posting frequency.
- **Reuse detection** — when a refresh token already revoked is presented, every refresh row for that user is revoked.
- **Family** — set of refresh rows derived from one initial login (rotation chain).
- **Cursor** — opaque base64 of `(createdAt, id)` for stable feed pagination.
- **MOD / ADMIN** — site-level role. Distinct from `ClubMember.role`, which is in-club.
- **FTS** — Postgres full-text search.
- **DPDPA** — Digital Personal Data Protection Act (India, 2023).
- **OWASP ASVS** — Application Security Verification Standard.
- **Jikan** — unofficial REST API for MyAnimeList data. Default upstream catalog provider.
- **MAL** — MyAnimeList.net.
- **AniList** — alternative anime database with GraphQL API.
- **Touch point** — code site that calls the CatalogProvider. Tracked in `mock.md`.
