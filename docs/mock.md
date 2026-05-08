# Jikan integration and swap procedure

This document is the **only** place that lists every Jikan touch point. When you need to swap Jikan for another catalog provider (MAL official, AniList, in-house), this is the file you read.

## Why local persistence

We mirror Jikan's data into our own PostgreSQL database for three reasons:

1. **Speed.** Local Postgres responds in single-digit ms. Jikan over the network is 200–800 ms.
2. **Independence.** Jikan rate limits (3/sec, 60/min) would cap us at low scale. Once data is local, our read traffic doesn't hit Jikan.
3. **Authority.** We can enrich data (community scores, custom tags, our own seasonal rankings) and become the source of truth for our users — the goal is to top every site that just proxies Jikan live.

## Provider abstraction

The interface lives at `src/lib/catalog/types.ts`:

```ts
export interface CatalogAnime {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  synopsis: string | null;
  type: string | null;
  episodes: number | null;
  status: string | null;
  airedFrom: Date | null;
  airedTo: Date | null;
  season: string | null;
  year: number | null;
  rating: string | null;
  score: number | null;
  imageUrl: string | null;
  trailerUrl: string | null;
  source: string | null;
  genres: string[];
  studios: string[];
}

export interface CatalogProvider {
  getAnimeByMalId(malId: number): Promise<CatalogAnime | null>;
  searchAnime(query: string, opts?: { limit?: number }): Promise<CatalogAnime[]>;
  getSeasonal(year: number, season: 'winter' | 'spring' | 'summer' | 'fall'): Promise<CatalogAnime[]>;
  getTopAnime(opts?: { type?: string; limit?: number }): Promise<CatalogAnime[]>;
}
```

The active provider is selected at startup by `CATALOG_PROVIDER` env (`jikan` | `mal` | `anilist`). Default: `jikan`.

`src/lib/catalog/index.ts`:

```ts
import { JikanProvider } from './jikan.provider';
import { MalProvider } from './mal.provider';
import { AnilistProvider } from './anilist.provider';
import { env } from '../../config/env';

export const catalog =
  env.CATALOG_PROVIDER === 'mal' ? new MalProvider() :
  env.CATALOG_PROVIDER === 'anilist' ? new AnilistProvider() :
  new JikanProvider();
```

**Every Jikan call must go through this abstraction.** No code outside `src/lib/catalog/` may import `undici` (or `fetch`) to hit Jikan directly. CI test:

```bash
grep -rnE "(api\.jikan\.moe|jikan)" src/ | grep -v "src/lib/catalog/" || echo "OK"
```

## Touch points (current Jikan usage)

These are the only places in the codebase where Jikan data flows in. Any swap must replicate these behaviors.

| # | Caller                                   | Provider method             | Used for                  | Local persistence target   |
| - | ---------------------------------------- | --------------------------- | ------------------------- | -------------------------- |
| 1 | `animeService.getById`                   | `getAnimeByMalId(malId)`    | Cold-path detail fetch    | `Anime` upsert + Genre/Studio |
| 2 | `animeService.refreshIfStale`            | `getAnimeByMalId(malId)`    | TTL-based refresh         | Same                       |
| 3 | `animeService.getSeasonal`               | `getSeasonal(year, season)` | Seasonal browse cold path | `Anime` upsert (bulk)      |
| 4 | `animeService.searchUpstream` (fallback) | `searchAnime(q)`            | Search miss in local FTS  | `Anime` upsert (bulk)      |
| 5 | `jobs/refreshTopAnime.cron.ts` (v1.1)    | `getTopAnime()`             | Daily warm refresh        | `Anime` upsert (bulk)      |
| 6 | `jobs/episodeDiscussion.cron.ts` (v1.1)  | `getAnimeByMalId(malId)`    | Detect new episode aired  | `Thread` create (not Anime) |

If you add a Jikan call elsewhere, **add a row to this table** in the same PR. This is enforced in the PR checklist (`conventions.md`).

## Jikan endpoint reference

Current implementation in `src/lib/catalog/jikan.provider.ts`:

| Method                | Jikan endpoint                                  | Notes                                  |
| --------------------- | ----------------------------------------------- | -------------------------------------- |
| `getAnimeByMalId(id)` | `GET /anime/{id}/full`                          | Single anime, full details             |
| `searchAnime(q, l)`   | `GET /anime?q={q}&limit={l}`                    | Title search                           |
| `getSeasonal(y, s)`   | `GET /seasons/{year}/{season}`                  | Paginated upstream; we fetch all pages |
| `getTopAnime(o)`      | `GET /top/anime?limit={l}` (+ optional `type=`) | Top by score                           |

Base URL: `env.JIKAN_BASE_URL` (default `https://api.jikan.moe/v4`).

Rate limiting: a token-bucket limiter inside the provider — 2 req/sec sustained (under Jikan's 3/sec ceiling) and a 60/min sliding window.

## Field mapping (Jikan → our `Anime` model)

This mapping is duplicated in `src/lib/catalog/jikan.provider.ts` as a single function `mapJikanToCatalog`. **A swap to another provider replaces this mapping function inside its own provider file.**

| Our column      | Jikan path                         | Notes                                   |
| --------------- | ---------------------------------- | --------------------------------------- |
| `malId`         | `data.mal_id`                      | Unique key                              |
| `title`         | `data.title`                       | Romaji default                          |
| `titleEnglish`  | `data.title_english`               | Nullable                                |
| `titleJapanese` | `data.title_japanese`              |                                         |
| `synopsis`      | `data.synopsis`                    |                                         |
| `type`          | `data.type`                        | TV, Movie, OVA, etc.                    |
| `episodes`      | `data.episodes`                    |                                         |
| `status`        | `data.status`                      | Airing / Finished / Not yet aired       |
| `airedFrom`     | `data.aired.from`                  | ISO                                     |
| `airedTo`       | `data.aired.to`                    |                                         |
| `season`        | `data.season`                      |                                         |
| `year`          | `data.year`                        |                                         |
| `rating`        | `data.rating`                      | G/PG/PG13/R/R+/Rx                       |
| `score`         | `data.score`                       | Float                                   |
| `imageUrl`      | `data.images.jpg.large_image_url`  | Prefer large                            |
| `trailerUrl`    | `data.trailer.url`                 | YouTube link                            |
| `source`        | `data.source`                      | Manga / Original / etc.                 |
| (genres)        | `data.genres[*].name`              | Upsert `Genre`, link via `AnimeGenre`   |
| (studios)       | `data.studios[*].name`             | Upsert `Studio`, link via `AnimeStudio` |

**Diff-and-update rule.** When refreshing an existing `Anime`, never touch user-attached relations (`ListEntry`, `Review`, `Thread`, `Post.animeId`, `PostComment`). Only update the columns above plus `genres`/`studios` reconciliation.

## Swap procedure (the "single command")

Run from repo root:

```bash
./scripts/swap.sh <provider>
# providers: jikan | mal | anilist
```

What `swap.sh` does:

1. Verifies the provider file exists at `src/lib/catalog/<provider>.provider.ts` and exports a class implementing `CatalogProvider`.
2. Updates `.env` (or `.env.production` if `NODE_ENV=production`): sets `CATALOG_PROVIDER=<provider>`.
3. Validates by running `npx tsx scripts/validateProvider.ts <provider>` which calls each method on the provider against a known anime (default: MAL ID 52991, "Sousou no Frieren") and asserts non-null fields.
4. Prints the summary: which methods worked, which failed, what to do next.
5. Does **not** restart the server — that's the operator's call. It also does **not** re-fetch existing data; refresh happens via the TTL on next read or via `refreshTopAnime` cron.

If the swap is to a provider with different field semantics (AniList uses different IDs, for example), see "Cross-ID migration" below.

## Cross-ID migration (Jikan/MAL ID → AniList ID)

If you swap to AniList, MAL IDs no longer index upstream. Strategy:

1. AniList's GraphQL API supports `Media(idMal: $id)` — keep using `Anime.malId` as the local stable key.
2. The AniList provider's `getAnimeByMalId(id)` issues `Media(idMal: id)` and maps the response.

If a future provider has no MAL-ID lookup, add an `Anime.externalIds Json` column and map per-provider IDs there.

## Validation script

`scripts/validateProvider.ts`:

```ts
import { JikanProvider } from '../src/lib/catalog/jikan.provider';
// import { MalProvider } from '../src/lib/catalog/mal.provider';
// import { AnilistProvider } from '../src/lib/catalog/anilist.provider';

const providers: Record<string, new () => any> = {
  jikan: JikanProvider,
  // mal: MalProvider,
  // anilist: AnilistProvider,
};

const which = process.argv[2];
const Provider = providers[which];
if (!Provider) {
  console.error('Unknown provider:', which);
  process.exit(1);
}

const p = new Provider();
const a = await p.getAnimeByMalId(52991);
if (!a || !a.title) {
  console.error('FAIL getAnimeByMalId');
  process.exit(2);
}
console.log('OK', a.title);
```

## What to update when adding a new provider

1. Create `src/lib/catalog/<name>.provider.ts` implementing `CatalogProvider`.
2. Register it in `src/lib/catalog/index.ts`.
3. Add `<name>` to the env enum in `src/config/env.ts`.
4. Update the touch points table in this file with any new touch points.
5. Add a row to the "Field mapping" section if the upstream schema differs.
6. Run `./scripts/swap.sh <name>` and confirm green.
7. Add a contract test under `tests/catalog.contract.test.ts` for the new provider.
