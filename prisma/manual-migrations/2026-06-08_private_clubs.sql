-- Private / invite-only clubs: visibility + invite links + join-request queue. ADDITIVE.

-- Enums (guard against re-run)
DO $$ BEGIN
  CREATE TYPE "ClubVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Club.visibility
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "visibility" "ClubVisibility" NOT NULL DEFAULT 'PUBLIC';

-- Shareable invite links
CREATE TABLE IF NOT EXISTS "ClubInvite" (
  "id"          TEXT PRIMARY KEY,
  "clubId"      TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3),
  "maxUses"     INTEGER,
  "uses"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubInvite_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClubInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClubInvite_code_key"   ON "ClubInvite"("code");
CREATE INDEX IF NOT EXISTS        "ClubInvite_clubId_idx" ON "ClubInvite"("clubId");
CREATE INDEX IF NOT EXISTS        "ClubInvite_code_idx"   ON "ClubInvite"("code");

-- Join-request queue (one open request per user/club)
CREATE TABLE IF NOT EXISTS "ClubJoinRequest" (
  "id"          TEXT PRIMARY KEY,
  "clubId"      TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "status"      "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
  "message"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"   TIMESTAMP(3),
  "decidedById" TEXT,
  CONSTRAINT "ClubJoinRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClubJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClubJoinRequest_clubId_userId_key" ON "ClubJoinRequest"("clubId","userId");
CREATE INDEX IF NOT EXISTS        "ClubJoinRequest_clubId_status_idx" ON "ClubJoinRequest"("clubId","status");
