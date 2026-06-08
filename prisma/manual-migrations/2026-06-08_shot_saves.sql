-- Shots premium: bookmark/save shots to a personal collection. ADDITIVE.

CREATE TABLE IF NOT EXISTS "ShotSave" (
  "userId"    TEXT NOT NULL,
  "shotId"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShotSave_pkey" PRIMARY KEY ("userId","shotId"),
  CONSTRAINT "ShotSave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShotSave_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "Shot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ShotSave_userId_createdAt_idx" ON "ShotSave"("userId","createdAt");
