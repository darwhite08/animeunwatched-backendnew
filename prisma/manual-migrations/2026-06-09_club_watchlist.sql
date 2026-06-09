-- Clubs P2: shared club watchlist. ADDITIVE.
CREATE TABLE IF NOT EXISTS "ClubWatchlistItem" (
  "id"        TEXT PRIMARY KEY,
  "clubId"    TEXT NOT NULL,
  "malId"     INTEGER NOT NULL,
  "title"     TEXT NOT NULL,
  "imageUrl"  TEXT,
  "addedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubWatchlistItem_clubId_fkey"    FOREIGN KEY ("clubId")    REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClubWatchlistItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClubWatchlistItem_clubId_malId_key" ON "ClubWatchlistItem"("clubId","malId");
CREATE INDEX IF NOT EXISTS "ClubWatchlistItem_clubId_createdAt_idx" ON "ClubWatchlistItem"("clubId","createdAt");
