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
