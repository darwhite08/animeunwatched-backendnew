-- Group chat (parallel to 1:1 DM). ADDITIVE — creates new tables only, does not
-- touch Conversation / DirectMessage. Safe to run against prod.

DO $$ BEGIN
  CREATE TYPE "GroupMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "GroupConversation" (
  "id"                  TEXT PRIMARY KEY,
  "title"               TEXT NOT NULL,
  "avatarUrl"           TEXT,
  "ownerId"             TEXT NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disappearingSeconds" INTEGER,
  "isE2EE"              BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "GroupConversation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GroupConversation_lastMessageAt_idx" ON "GroupConversation"("lastMessageAt");
CREATE INDEX IF NOT EXISTS "GroupConversation_ownerId_idx" ON "GroupConversation"("ownerId");

CREATE TABLE IF NOT EXISTS "GroupMember" (
  "id"          TEXT PRIMARY KEY,
  "groupId"     TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "role"        "GroupMemberRole" NOT NULL DEFAULT 'MEMBER',
  "joinedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "addedBy"     TEXT,
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "lastReadAt"  TIMESTAMP(3),
  "mutedUntil"  TIMESTAMP(3),
  "archived"    BOOLEAN NOT NULL DEFAULT false,
  "pinned"      BOOLEAN NOT NULL DEFAULT false,
  "leftAt"      TIMESTAMP(3),
  CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GroupMember_userId_fkey"  FOREIGN KEY ("userId")  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");
CREATE INDEX IF NOT EXISTS "GroupMember_userId_archived_idx" ON "GroupMember"("userId", "archived");
CREATE INDEX IF NOT EXISTS "GroupMember_groupId_idx" ON "GroupMember"("groupId");

CREATE TABLE IF NOT EXISTS "GroupMessage" (
  "id"             TEXT PRIMARY KEY,
  "groupId"        TEXT NOT NULL,
  "senderId"       TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "type"           "MessageType" NOT NULL DEFAULT 'TEXT',
  "body"           TEXT,
  "animeMalId"     INTEGER,
  "animeEpisode"   INTEGER,
  "mediaUrl"       TEXT,
  "mediaMime"      TEXT,
  "mediaSizeBytes" INTEGER,
  "mediaWidth"     INTEGER,
  "mediaHeight"    INTEGER,
  "mediaDurationS" INTEGER,
  "mediaBlurhash"  TEXT,
  "replyToId"      TEXT,
  "editedAt"       TIMESTAMP(3),
  "clientNonce"    TEXT,
  "expiresAt"      TIMESTAMP(3),
  "ciphertext"     TEXT,
  "contentIv"      TEXT,
  "frankingTag"    TEXT,
  "serverFrank"    TEXT,
  "isE2EE"         BOOLEAN NOT NULL DEFAULT false,
  "deletedAt"      TIMESTAMP(3),
  CONSTRAINT "GroupMessage_groupId_fkey"   FOREIGN KEY ("groupId")   REFERENCES "GroupConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GroupMessage_senderId_fkey"  FOREIGN KEY ("senderId")  REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "GroupMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "GroupMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "GroupMessage_groupId_clientNonce_key" ON "GroupMessage"("groupId", "clientNonce");
CREATE INDEX IF NOT EXISTS "GroupMessage_groupId_createdAt_idx" ON "GroupMessage"("groupId", "createdAt");
CREATE INDEX IF NOT EXISTS "GroupMessage_senderId_idx" ON "GroupMessage"("senderId");
CREATE INDEX IF NOT EXISTS "GroupMessage_expiresAt_idx" ON "GroupMessage"("expiresAt");

CREATE TABLE IF NOT EXISTS "GroupMessageEnvelope" (
  "id"           TEXT PRIMARY KEY,
  "messageId"    TEXT NOT NULL,
  "deviceId"     TEXT NOT NULL,
  "ephemeralPub" TEXT NOT NULL,
  "wrappedCK"    TEXT NOT NULL,
  "wrapIv"       TEXT NOT NULL,
  CONSTRAINT "GroupMessageEnvelope_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GroupMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "GroupMessageEnvelope_messageId_deviceId_key" ON "GroupMessageEnvelope"("messageId", "deviceId");
CREATE INDEX IF NOT EXISTS "GroupMessageEnvelope_deviceId_idx" ON "GroupMessageEnvelope"("deviceId");

CREATE TABLE IF NOT EXISTS "GroupMessageReaction" (
  "id"        TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "emoji"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroupMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GroupMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GroupMessageReaction_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "GroupMessageReaction_messageId_userId_emoji_key" ON "GroupMessageReaction"("messageId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "GroupMessageReaction_messageId_idx" ON "GroupMessageReaction"("messageId");

CREATE TABLE IF NOT EXISTS "GroupMessageHide" (
  "messageId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  CONSTRAINT "GroupMessageHide_pkey" PRIMARY KEY ("messageId", "userId"),
  CONSTRAINT "GroupMessageHide_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GroupMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GroupMessageHide_userId_idx" ON "GroupMessageHide"("userId");
