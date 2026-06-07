-- ============================================================================
-- Shots (short vertical videos / reels) — ADDITIVE, no data loss. REVIEW before prod.
--
-- Why: phase 2 of the mobile Shots feature — user-uploaded short clips with a
-- cursor feed and likes. New tables only; nothing existing changes, so the
-- currently-deployed backend is unaffected until the shots module ships.
--
-- HOW TO APPLY (App Runner deploys do NOT run prisma migrate — apply by hand
-- BEFORE the code deploy lands, see docs/claude-memory/prod-deploy-schema-drift):
--   aws ec2 authorize-security-group-ingress --group-id sg-0759edd222f95d3e3 \
--     --protocol tcp --port 5432 --cidr <your-ip>/32
--   npx prisma db execute --url "$PROD_URL" --file prisma/manual-migrations/2026-06-07_shots.sql
--   aws ec2 revoke-security-group-ingress  --group-id sg-0759edd222f95d3e3 \
--     --protocol tcp --port 5432 --cidr <your-ip>/32
--
-- Safe to run on prod: CREATE TABLE/INDEX IF NOT EXISTS only.
-- Reversible: DROP TABLE "ShotLike", "Shot";
-- ============================================================================

-- 1) Shots
CREATE TABLE IF NOT EXISTS "Shot" (
  "id"           TEXT NOT NULL,
  "authorId"     TEXT NOT NULL,
  "caption"      TEXT,
  "videoUrl"     TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "durationMs"   INTEGER,
  "animeId"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "deletedAt"    TIMESTAMP(3),
  CONSTRAINT "Shot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Shot_createdAt_idx"          ON "Shot"("createdAt");
CREATE INDEX IF NOT EXISTS "Shot_authorId_createdAt_idx" ON "Shot"("authorId","createdAt");
CREATE INDEX IF NOT EXISTS "Shot_animeId_idx"            ON "Shot"("animeId");
ALTER TABLE "Shot"
  DROP CONSTRAINT IF EXISTS "Shot_authorId_fkey",
  ADD  CONSTRAINT "Shot_authorId_fkey"
       FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shot"
  DROP CONSTRAINT IF EXISTS "Shot_animeId_fkey",
  ADD  CONSTRAINT "Shot_animeId_fkey"
       FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Shot likes (composite PK, mirrors PostLike)
CREATE TABLE IF NOT EXISTS "ShotLike" (
  "userId" TEXT NOT NULL,
  "shotId" TEXT NOT NULL,
  CONSTRAINT "ShotLike_pkey" PRIMARY KEY ("userId","shotId")
);
ALTER TABLE "ShotLike"
  DROP CONSTRAINT IF EXISTS "ShotLike_userId_fkey",
  ADD  CONSTRAINT "ShotLike_userId_fkey"
       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShotLike"
  DROP CONSTRAINT IF EXISTS "ShotLike_shotId_fkey",
  ADD  CONSTRAINT "ShotLike_shotId_fkey"
       FOREIGN KEY ("shotId") REFERENCES "Shot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
