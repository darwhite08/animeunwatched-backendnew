-- ============================================================================
-- Peeak (24-hour stories) — ADDITIVE, no data loss. REVIEW before prod.
--
-- Why: stories rail on the mobile Messages screen. New tables only.
-- Apply together with 2026-06-07_shots.sql (same procedure — see that file's
-- header for the SG-ingress steps; App Runner does NOT run prisma migrate).
--
-- Safe to run on prod: CREATE TABLE/INDEX IF NOT EXISTS only.
-- Reversible: DROP TABLE "StoryView", "Story";
-- ============================================================================

-- 1) Stories
CREATE TABLE IF NOT EXISTS "Story" (
  "id"        TEXT NOT NULL,
  "authorId"  TEXT NOT NULL,
  "mediaUrl"  TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "caption"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Story_authorId_createdAt_idx" ON "Story"("authorId","createdAt");
CREATE INDEX IF NOT EXISTS "Story_expiresAt_idx"          ON "Story"("expiresAt");
ALTER TABLE "Story"
  DROP CONSTRAINT IF EXISTS "Story_authorId_fkey",
  ADD  CONSTRAINT "Story_authorId_fkey"
       FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Story views (seen/unseen ring state)
CREATE TABLE IF NOT EXISTS "StoryView" (
  "userId"   TEXT NOT NULL,
  "storyId"  TEXT NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoryView_pkey" PRIMARY KEY ("userId","storyId")
);
ALTER TABLE "StoryView"
  DROP CONSTRAINT IF EXISTS "StoryView_userId_fkey",
  ADD  CONSTRAINT "StoryView_userId_fkey"
       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryView"
  DROP CONSTRAINT IF EXISTS "StoryView_storyId_fkey",
  ADD  CONSTRAINT "StoryView_storyId_fkey"
       FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
