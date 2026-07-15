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
