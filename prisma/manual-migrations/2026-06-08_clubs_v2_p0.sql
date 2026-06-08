-- Clubs 2.0 — P0 (identity, onboarding, events, announcements). ADDITIVE.

-- Club identity
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "bannerUrl" TEXT;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "rules" TEXT;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "welcomeMessage" TEXT;

-- ClubMember onboarding + xp
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "agreedRulesAt" TIMESTAMP(3);
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "onboardedAt"   TIMESTAMP(3);
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "xp"            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClubMember" ADD COLUMN IF NOT EXISTS "lastXpAt"      TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ClubMember_clubId_xp_idx" ON "ClubMember"("clubId", "xp");

-- Thread kind / pinning / episode
DO $$ BEGIN
  CREATE TYPE "ThreadKind" AS ENUM ('DISCUSSION', 'ANNOUNCEMENT', 'CHALLENGE', 'EPISODE');
EXCEPTION WHEN duplicate_object THEN null; END $$;
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "kind" "ThreadKind" NOT NULL DEFAULT 'DISCUSSION';
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "pinnedUntil"   TIMESTAMP(3);
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "episodeNumber" INTEGER;
-- Backfill: existing watch-challenge threads → CHALLENGE kind
UPDATE "Thread" SET "kind" = 'CHALLENGE' WHERE "title" LIKE '[CHALLENGE]%' AND "kind" = 'DISCUSSION';

-- Events
DO $$ BEGIN
  CREATE TYPE "ClubEventKind" AS ENUM ('WATCH_PARTY', 'AMA', 'GAME_NIGHT', 'GENERAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "RSVPStatus" AS ENUM ('GOING', 'MAYBE', 'NOT_GOING');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "ClubEvent" (
  "id"            TEXT PRIMARY KEY,
  "clubId"        TEXT NOT NULL,
  "creatorId"     TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "description"   TEXT,
  "kind"          "ClubEventKind" NOT NULL DEFAULT 'WATCH_PARTY',
  "animeMalId"    INTEGER,
  "episodeNumber" INTEGER,
  "startsAt"      TIMESTAMP(3) NOT NULL,
  "endsAt"        TIMESTAMP(3),
  "location"      TEXT,
  "remindedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubEvent_clubId_fkey"    FOREIGN KEY ("clubId")    REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClubEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ClubEvent_clubId_startsAt_idx" ON "ClubEvent"("clubId", "startsAt");
CREATE INDEX IF NOT EXISTS "ClubEvent_startsAt_idx" ON "ClubEvent"("startsAt");

CREATE TABLE IF NOT EXISTS "ClubEventRSVP" (
  "eventId"   TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "status"    "RSVPStatus" NOT NULL DEFAULT 'GOING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubEventRSVP_pkey" PRIMARY KEY ("eventId", "userId"),
  CONSTRAINT "ClubEventRSVP_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ClubEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClubEventRSVP_userId_fkey"  FOREIGN KEY ("userId")  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ClubEventRSVP_userId_idx" ON "ClubEventRSVP"("userId");
