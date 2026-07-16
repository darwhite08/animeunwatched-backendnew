import { prisma } from "../config/prisma";

// App Runner deploys from source and starts with `node dist/server.js` — it does
// NOT run `prisma db push`/`migrate`, so additive schema changes must be applied
// another way, and the RDS instance is private (unreachable from a laptop). This
// idempotent boot hook self-applies the Blog Draft Channel schema, matching the
// existing ensureAdminSeed / seedPiiInventory convention. Every statement is
// IF-NOT-EXISTS safe; a fast pre-check makes normal boots a single cheap SELECT.

const STATEMENTS: string[] = [
  // New enum value (own autocommit statement — cannot run inside a transaction).
  `ALTER TYPE "BlogStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW'`,
  // IntegrationKey table + indexes + FK.
  `CREATE TABLE IF NOT EXISTS "IntegrationKey" (
     "id" TEXT NOT NULL,
     "ownerId" TEXT NOT NULL,
     "label" TEXT NOT NULL,
     "keyHash" TEXT NOT NULL,
     "keyPrefix" TEXT NOT NULL,
     "revoked" BOOLEAN NOT NULL DEFAULT false,
     "draftCount" INTEGER NOT NULL DEFAULT 0,
     "lastUsedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "IntegrationKey_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationKey_keyHash_key" ON "IntegrationKey"("keyHash")`,
  `CREATE INDEX IF NOT EXISTS "IntegrationKey_ownerId_idx" ON "IntegrationKey"("ownerId")`,
  `DO $$ BEGIN
     ALTER TABLE "IntegrationKey"
       ADD CONSTRAINT "IntegrationKey_ownerId_fkey"
       FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // Blog provenance columns.
  `ALTER TABLE "Blog" ADD COLUMN IF NOT EXISTS "sourceKeyId" TEXT`,
  `ALTER TABLE "Blog" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Blog_idempotencyKey_key" ON "Blog"("idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "Blog_sourceKeyId_idx" ON "Blog"("sourceKeyId")`,
  `DO $$ BEGIN
     ALTER TABLE "Blog"
       ADD CONSTRAINT "Blog_sourceKeyId_fkey"
       FOREIGN KEY ("sourceKeyId") REFERENCES "IntegrationKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

// ─── Notification grouping (DM collapse) ────────────────────────────────────
// Own ensure function with its OWN marker fast-path — these must never live in
// another ensure's statement list, whose fast-path would skip them once ITS
// marker exists (that exact mistake 500'd the notifications feed once).
const NOTIF_STATEMENTS: string[] = [
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "groupKey" TEXT`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "count" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Notification_recipientId_groupKey_key" ON "Notification"("recipientId", "groupKey")`,
  `CREATE INDEX IF NOT EXISTS "Notification_recipientId_updatedAt_idx" ON "Notification"("recipientId", "updatedAt")`,
  // Clean up the legacy one-row-per-message staff DM flood; the new grouped
  // "message" notifications replace them.
  `DELETE FROM "Notification" WHERE type = 'system' AND payload->>'kind' = 'dm_from_staff'`,
];

export async function ensureNotificationGroupingSchema(): Promise<{ applied: boolean }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'Notification' AND column_name = 'groupKey'
     ) AS present`,
  ).catch(() => [{ present: false }] as Array<{ present: boolean }>);
  if (rows?.[0]?.present) return { applied: false };

  for (const sql of NOTIF_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error("[notif-ensure] statement failed (continuing):", (err as Error).message);
    }
  }
  return { applied: true };
}

export async function ensureBlogDraftChannelSchema(): Promise<{ applied: boolean }> {
  // Fast path: marker column present → nothing to do.
  const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'Blog' AND column_name = 'idempotencyKey'
     ) AS present`,
  );
  if (rows?.[0]?.present) return { applied: false };

  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      // Idempotent statements can still race two booting instances — log and
      // continue; a subsequent boot converges the schema.
      console.error("[schema-ensure] statement failed (continuing):", (err as Error).message);
    }
  }
  return { applied: true };
}

// ─── Anime fuzzy search (pg_trgm) ────────────────────────────────────────────
// Enables multi-title fuzzy search: a normalized "searchText" haystack (all
// title variants) + a pg_trgm GIN index for similarity()/LIKE. Idempotent; the
// backfill only touches rows that don't yet have searchText, and the SQL
// normalization is kept in lockstep with lib/searchText.ts (NFKD≈unaccent,
// [^a-z0-9]→space) so backfilled + upserted rows normalize identically.
const SEARCH_STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `ALTER TABLE "Anime" ADD COLUMN IF NOT EXISTS "searchText" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Anime_searchText_trgm_idx" ON "Anime" USING gin ("searchText" gin_trgm_ops)`,
  // Backfill existing rows once (idempotent: only NULL searchText).
  `UPDATE "Anime" SET "searchText" = trim(regexp_replace(lower(unaccent(
       coalesce(title,'') || ' ' || coalesce("titleEnglish",'') || ' ' ||
       array_to_string(coalesce("titleSynonyms", '{}'), ' ')
     )), '[^a-z0-9]+', ' ', 'g'))
   WHERE "searchText" IS NULL`,
  // "Request a missing title" store.
  `CREATE TABLE IF NOT EXISTS "AnimeTitleRequest" (
     "id" TEXT NOT NULL,
     "query" TEXT NOT NULL,
     "rawQuery" TEXT NOT NULL,
     "requestCount" INTEGER NOT NULL DEFAULT 1,
     "lastRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AnimeTitleRequest_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AnimeTitleRequest_query_key" ON "AnimeTitleRequest"("query")`,
];

// ─── Manga catalog ───────────────────────────────────────────────────────────
// Manga table + MangaGenre join + MangaEntry catalog-link columns. Own ensure
// with its OWN marker fast-path (see the note above NOTIF_STATEMENTS). The
// trigram index statements assume pg_trgm/unaccent exist — ensureAnimeSearchSchema
// created them, but CREATE EXTENSION IF NOT EXISTS is repeated here so this
// ensure is self-sufficient on a fresh database.
const MANGA_STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE TABLE IF NOT EXISTS "Manga" (
     "id" TEXT NOT NULL,
     "malId" INTEGER NOT NULL,
     "slug" TEXT,
     "title" TEXT NOT NULL,
     "titleEnglish" TEXT,
     "titleJapanese" TEXT,
     "titleSynonyms" TEXT[] NOT NULL DEFAULT '{}',
     "searchText" TEXT,
     "synopsis" TEXT,
     "background" TEXT,
     "type" TEXT,
     "chapters" INTEGER,
     "volumes" INTEGER,
     "status" TEXT,
     "publishing" BOOLEAN NOT NULL DEFAULT false,
     "publishedFrom" TIMESTAMP(3),
     "publishedTo" TIMESTAMP(3),
     "demographic" TEXT,
     "authors" TEXT[] NOT NULL DEFAULT '{}',
     "serializations" TEXT[] NOT NULL DEFAULT '{}',
     "score" DOUBLE PRECISION,
     "scoredBy" INTEGER,
     "rank" INTEGER,
     "popularity" INTEGER,
     "membersCount" INTEGER,
     "favoritesCount" INTEGER,
     "imageUrl" TEXT,
     "imageSmallUrl" TEXT,
     "imageWebpUrl" TEXT,
     "lastSyncedAt" TIMESTAMP(3),
     "syncPriority" "SyncPriority" NOT NULL DEFAULT 'NORMAL',
     "syncFailCount" INTEGER NOT NULL DEFAULT 0,
     "isStub" BOOLEAN NOT NULL DEFAULT false,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "Manga_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Manga_malId_key" ON "Manga"("malId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Manga_slug_key" ON "Manga"("slug")`,
  `CREATE INDEX IF NOT EXISTS "Manga_malId_idx" ON "Manga"("malId")`,
  `CREATE INDEX IF NOT EXISTS "Manga_slug_idx" ON "Manga"("slug")`,
  `CREATE INDEX IF NOT EXISTS "Manga_score_idx" ON "Manga"("score")`,
  `CREATE INDEX IF NOT EXISTS "Manga_popularity_idx" ON "Manga"("popularity")`,
  `CREATE INDEX IF NOT EXISTS "Manga_status_syncPriority_idx" ON "Manga"("status", "syncPriority")`,
  `CREATE INDEX IF NOT EXISTS "Manga_syncPriority_lastSyncedAt_idx" ON "Manga"("syncPriority", "lastSyncedAt")`,
  `CREATE INDEX IF NOT EXISTS "Manga_demographic_idx" ON "Manga"("demographic")`,
  `CREATE INDEX IF NOT EXISTS "Manga_searchText_trgm_idx" ON "Manga" USING gin ("searchText" gin_trgm_ops)`,
  `CREATE TABLE IF NOT EXISTS "MangaGenre" (
     "mangaId" TEXT NOT NULL,
     "genreId" TEXT NOT NULL,
     CONSTRAINT "MangaGenre_pkey" PRIMARY KEY ("mangaId", "genreId")
   )`,
  `CREATE INDEX IF NOT EXISTS "MangaGenre_genreId_idx" ON "MangaGenre"("genreId")`,
  `DO $$ BEGIN
     ALTER TABLE "MangaGenre"
       ADD CONSTRAINT "MangaGenre_mangaId_fkey"
       FOREIGN KEY ("mangaId") REFERENCES "Manga"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "MangaGenre"
       ADD CONSTRAINT "MangaGenre_genreId_fkey"
       FOREIGN KEY ("genreId") REFERENCES "Genre"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // Readlist → catalog link. anilistId becomes optional (legacy-only). Guarded
  // on table existence so a FRESH database (where prisma db push creates the
  // final shape directly and this table may not exist yet at ensure time)
  // doesn't error on every boot.
  `DO $$ BEGIN
     IF to_regclass('"MangaEntry"') IS NOT NULL THEN
       ALTER TABLE "MangaEntry" ALTER COLUMN "anilistId" DROP NOT NULL;
       ALTER TABLE "MangaEntry" ADD COLUMN IF NOT EXISTS "mangaId" TEXT;
       ALTER TABLE "MangaEntry" ADD COLUMN IF NOT EXISTS "volumesRead" INTEGER NOT NULL DEFAULT 0;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF to_regclass('"MangaEntry"') IS NOT NULL THEN
       CREATE UNIQUE INDEX IF NOT EXISTS "MangaEntry_userId_mangaId_key" ON "MangaEntry"("userId", "mangaId");
       CREATE INDEX IF NOT EXISTS "MangaEntry_mangaId_idx" ON "MangaEntry"("mangaId");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF to_regclass('"MangaEntry"') IS NOT NULL THEN
       BEGIN
         ALTER TABLE "MangaEntry"
           ADD CONSTRAINT "MangaEntry_mangaId_fkey"
           FOREIGN KEY ("mangaId") REFERENCES "Manga"("id") ON DELETE SET NULL ON UPDATE CASCADE;
       EXCEPTION WHEN duplicate_object THEN NULL; END;
     END IF;
   END $$`,
  // Title requests now carry which catalog they target.
  `DO $$ BEGIN
     IF to_regclass('"AnimeTitleRequest"') IS NOT NULL THEN
       ALTER TABLE "AnimeTitleRequest" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'anime';
     END IF;
   END $$`,
]

export async function ensureMangaSchema(): Promise<{ applied: boolean }> {
  // Fast path: Manga table exists AND the readlist link column landed (or the
  // readlist table doesn't exist at all — fresh DB, prisma creates it fully).
  const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT (
       to_regclass('"Manga"') IS NOT NULL AND (
         to_regclass('"MangaEntry"') IS NULL OR EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'MangaEntry' AND column_name = 'mangaId'
         )
       )
     ) AS present`,
  ).catch(() => [{ present: false }] as Array<{ present: boolean }>);
  if (rows?.[0]?.present) return { applied: false };

  for (const sql of MANGA_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error("[manga-ensure] statement failed (continuing):", (err as Error).message);
    }
  }
  return { applied: true };
}

export async function ensureAnimeSearchSchema(): Promise<{ applied: boolean }> {
  // Fast path: index present AND no un-backfilled rows → nothing to do.
  const rows = await prisma.$queryRawUnsafe<Array<{ pending: number }>>(
    `SELECT (
       CASE WHEN to_regclass('"Anime_searchText_trgm_idx"') IS NULL THEN 1
            ELSE (SELECT count(*) FROM "Anime" WHERE "searchText" IS NULL)
       END)::int AS pending`,
  ).catch(() => [{ pending: 1 }] as Array<{ pending: number }>);
  if (rows?.[0]?.pending === 0) return { applied: false };

  for (const sql of SEARCH_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error("[search-ensure] statement failed (continuing):", (err as Error).message);
    }
  }
  return { applied: true };
}
