-- ============================================================================
-- Multi-device E2E chat keys — Phase 1 (ADDITIVE, no data loss). REVIEW before prod.
--
-- Why: chat keys were single-per-user (UserPublicKey.userId is PK), so a 2nd
-- device would overwrite the key and break the first. This adds per-device keys
-- and per-recipient-device message-key envelopes WITHOUT changing the existing
-- send/read path. Nothing breaks until Phase 2 (client crypto) ships.
--
-- HOW TO APPLY (pick one):
--   A) Schema-sync (matches your current `db push` workflow):
--        npx prisma db push           # creates tables + the nullable column
--        psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-03_multidevice_chat_keys.sql
--        # ^ db push makes the structures; then run ONLY the backfill (step 4) —
--        #   steps 1-3 will already exist, so run step 4 alone, or use IF NOT EXISTS.
--   B) Run this whole script directly against the DB (no db push):
--        psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-03_multidevice_chat_keys.sql
--
-- Safe to run on prod: only CREATE TABLE / ADD COLUMN (nullable) / INSERT.
-- Reversible: DROP TABLE "MessageKeyEnvelope","UserDeviceKey"; ALTER TABLE
--             "DirectMessage" DROP COLUMN "senderDeviceKeyId";
-- ============================================================================

-- 1) Per-device public keys (many per user)
CREATE TABLE IF NOT EXISTS "UserDeviceKey" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "deviceId"   TEXT NOT NULL,
  "publicKey"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserDeviceKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserDeviceKey_userId_deviceId_key" ON "UserDeviceKey"("userId","deviceId");
CREATE INDEX IF NOT EXISTS "UserDeviceKey_userId_idx" ON "UserDeviceKey"("userId");
ALTER TABLE "UserDeviceKey"
  DROP CONSTRAINT IF EXISTS "UserDeviceKey_userId_fkey",
  ADD  CONSTRAINT "UserDeviceKey_userId_fkey"
       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Per-recipient-device wrapped message keys (server stores wrapped material only)
CREATE TABLE IF NOT EXISTS "MessageKeyEnvelope" (
  "id"                   TEXT NOT NULL,
  "messageId"            TEXT NOT NULL,
  "recipientDeviceKeyId" TEXT NOT NULL,
  "wrappedKey"           TEXT NOT NULL,
  "wrapIv"               TEXT NOT NULL,
  CONSTRAINT "MessageKeyEnvelope_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MessageKeyEnvelope_messageId_recipientDeviceKeyId_key"
  ON "MessageKeyEnvelope"("messageId","recipientDeviceKeyId");
CREATE INDEX IF NOT EXISTS "MessageKeyEnvelope_recipientDeviceKeyId_idx"
  ON "MessageKeyEnvelope"("recipientDeviceKeyId");
ALTER TABLE "MessageKeyEnvelope"
  DROP CONSTRAINT IF EXISTS "MessageKeyEnvelope_messageId_fkey",
  ADD  CONSTRAINT "MessageKeyEnvelope_messageId_fkey"
       FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageKeyEnvelope"
  DROP CONSTRAINT IF EXISTS "MessageKeyEnvelope_recipientDeviceKeyId_fkey",
  ADD  CONSTRAINT "MessageKeyEnvelope_recipientDeviceKeyId_fkey"
       FOREIGN KEY ("recipientDeviceKeyId") REFERENCES "UserDeviceKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Additive nullable column on DirectMessage (legacy messages stay NULL)
ALTER TABLE "DirectMessage" ADD COLUMN IF NOT EXISTS "senderDeviceKeyId" TEXT;
ALTER TABLE "DirectMessage"
  DROP CONSTRAINT IF EXISTS "DirectMessage_senderDeviceKeyId_fkey",
  ADD  CONSTRAINT "DirectMessage_senderDeviceKeyId_fkey"
       FOREIGN KEY ("senderDeviceKeyId") REFERENCES "UserDeviceKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Backfill: existing single per-user keys become deviceId='legacy' so current
--    devices keep working as a registered device under the new model.
INSERT INTO "UserDeviceKey" ("id","userId","deviceId","publicKey","createdAt","lastSeenAt")
SELECT 'legacy_' || "userId", "userId", 'legacy', "publicKey",
       COALESCE("updatedAt", CURRENT_TIMESTAMP), COALESCE("updatedAt", CURRENT_TIMESTAMP)
FROM "UserPublicKey"
ON CONFLICT ("userId","deviceId") DO NOTHING;
