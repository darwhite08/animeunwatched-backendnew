-- Thread reactions + club member moderation. ADDITIVE.
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "mutedUntil" TIMESTAMP(3);
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "strikes" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "ThreadReaction" (
  "id"         TEXT PRIMARY KEY,
  "targetId"   TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "emoji"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ThreadReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ThreadReaction_targetId_userId_emoji_key" ON "ThreadReaction"("targetId","userId","emoji");
CREATE INDEX IF NOT EXISTS "ThreadReaction_targetId_idx" ON "ThreadReaction"("targetId");
