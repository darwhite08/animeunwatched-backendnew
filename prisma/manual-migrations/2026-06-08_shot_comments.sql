-- Shots Phase 2: comments on shots (flat, soft-deletable). ADDITIVE.

CREATE TABLE IF NOT EXISTS "ShotComment" (
  "id"        TEXT PRIMARY KEY,
  "shotId"    TEXT NOT NULL,
  "authorId"  TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ShotComment_shotId_fkey"   FOREIGN KEY ("shotId")   REFERENCES "Shot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShotComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ShotComment_shotId_createdAt_idx" ON "ShotComment"("shotId","createdAt");
