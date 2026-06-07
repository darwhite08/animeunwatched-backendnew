-- ============================================================================
-- DM Chat v2 — server-readable messaging (requests, blocks, reports, privacy,
-- media, replies, presence). ADDITIVE + nullable; no data loss. REVIEW before prod.
--
-- App Runner does NOT run prisma migrate (see docs/.../prod-deploy-schema-drift),
-- so apply this by hand BEFORE the code deploy lands. The Dockerfile's
-- `prisma db push` will also converge the schema, but running this first makes
-- the rollout explicit and lets the backfill run once.
--
-- Reversible-ish: new columns/tables are additive; ciphertext/iv become
-- nullable (was NOT NULL). To roll back, drop the new tables/columns.
-- ============================================================================

-- 1) Enums
DO $$ BEGIN
  CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'PENDING', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VOICE', 'ANIME_CARD', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) User — DM privacy prefs
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "dmPrivacy"        TEXT    NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS "readReceiptsOn"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showOnlineStatus" TEXT    NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS "dmLastSeenAt"     TIMESTAMP(3);

-- 3) Conversation — request state + denormalized per-participant inbox state
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "status"        "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "initiatorId"   TEXT,
  ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "p1UnreadCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "p2UnreadCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "p1MutedUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "p2MutedUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "p1DeletedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "p2DeletedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "p1LastReadAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "p2LastReadAt"  TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Conversation_participant1_lastMessageAt_idx" ON "Conversation"("participant1","lastMessageAt");
CREATE INDEX IF NOT EXISTS "Conversation_participant2_lastMessageAt_idx" ON "Conversation"("participant2","lastMessageAt");
CREATE INDEX IF NOT EXISTS "Conversation_status_idx" ON "Conversation"("status");

-- 4) DirectMessage — server-readable content + media + reply + status
ALTER TABLE "DirectMessage"
  ADD COLUMN IF NOT EXISTS "deliveredAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "type"           "MessageType" NOT NULL DEFAULT 'TEXT',
  ADD COLUMN IF NOT EXISTS "body"           TEXT,
  ADD COLUMN IF NOT EXISTS "animeMalId"     INTEGER,
  ADD COLUMN IF NOT EXISTS "animeEpisode"   INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaUrl"       TEXT,
  ADD COLUMN IF NOT EXISTS "mediaMime"      TEXT,
  ADD COLUMN IF NOT EXISTS "mediaSizeBytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaWidth"     INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaHeight"    INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaDurationS" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaBlurhash"  TEXT,
  ADD COLUMN IF NOT EXISTS "replyToId"      TEXT,
  ADD COLUMN IF NOT EXISTS "editedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clientNonce"    TEXT;

-- ciphertext/iv were NOT NULL (legacy E2E) — make nullable for v2 plaintext rows
ALTER TABLE "DirectMessage" ALTER COLUMN "ciphertext" DROP NOT NULL;
ALTER TABLE "DirectMessage" ALTER COLUMN "iv"         DROP NOT NULL;

-- self-relation FK for replies (SetNull so deleting a quoted message is safe)
DO $$ BEGIN
  ALTER TABLE "DirectMessage"
    ADD CONSTRAINT "DirectMessage_replyToId_fkey"
    FOREIGN KEY ("replyToId") REFERENCES "DirectMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "DirectMessage_conversationId_clientNonce_key" ON "DirectMessage"("conversationId","clientNonce");

-- 5) UserBlock
CREATE TABLE IF NOT EXISTS "UserBlock" (
  "id"        TEXT NOT NULL,
  "blockerId" TEXT NOT NULL,
  "blockedId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserBlock_blockerId_blockedId_key" ON "UserBlock"("blockerId","blockedId");
CREATE INDEX IF NOT EXISTS "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");
DO $$ BEGIN
  ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6) MessageReport (immutable snapshot in details)
CREATE TABLE IF NOT EXISTS "MessageReport" (
  "id"             TEXT NOT NULL,
  "reporterId"     TEXT NOT NULL,
  "reportedUserId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId"      TEXT,
  "reason"         TEXT NOT NULL,
  "details"        TEXT,
  "status"         TEXT NOT NULL DEFAULT 'open',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MessageReport_status_createdAt_idx"   ON "MessageReport"("status","createdAt");
CREATE INDEX IF NOT EXISTS "MessageReport_reportedUserId_idx"     ON "MessageReport"("reportedUserId");

-- 7) Backfill --------------------------------------------------------------
-- 7a) Denormalize lastMessageAt + initiator from existing messages.
UPDATE "Conversation" c SET "lastMessageAt" = COALESCE(
  (SELECT MAX(m."createdAt") FROM "DirectMessage" m WHERE m."conversationId" = c."id"),
  c."createdAt"
);
UPDATE "Conversation" c SET "initiatorId" = (
  SELECT m."senderId" FROM "DirectMessage" m WHERE m."conversationId" = c."id"
  ORDER BY m."createdAt" ASC LIMIT 1
) WHERE c."initiatorId" IS NULL;

-- 7b) Recover plaintext for legacy PLAIN_NO_E2E messages (base64 in ciphertext).
--     Genuinely-encrypted rows (iv != marker) are left as-is (body stays NULL;
--     clients render them via the legacy decrypt path / "legacy encrypted").
UPDATE "DirectMessage"
SET "body" = convert_from(decode("ciphertext", 'base64'), 'UTF8'), "type" = 'TEXT'
WHERE "iv" = 'PLAIN_NO_E2E' AND "body" IS NULL AND "ciphertext" IS NOT NULL AND "ciphertext" <> '';

-- 7c) Seed per-participant unread counters from unread received messages.
UPDATE "Conversation" c SET "p1UnreadCount" = (
  SELECT COUNT(*) FROM "DirectMessage" m
  WHERE m."conversationId" = c."id" AND m."senderId" <> c."participant1" AND m."readAt" IS NULL
);
UPDATE "Conversation" c SET "p2UnreadCount" = (
  SELECT COUNT(*) FROM "DirectMessage" m
  WHERE m."conversationId" = c."id" AND m."senderId" <> c."participant2" AND m."readAt" IS NULL
);
