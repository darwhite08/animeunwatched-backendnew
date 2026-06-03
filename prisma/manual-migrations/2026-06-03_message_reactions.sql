-- Message reactions (emoji on DMs) — ADDITIVE, no data loss. REVIEW before prod.
-- Apply: `npx prisma db push`  OR run this script via psql.
-- Reversible: DROP TABLE "MessageReaction";
CREATE TABLE IF NOT EXISTS "MessageReaction" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "emoji"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId","userId","emoji");
CREATE INDEX IF NOT EXISTS "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");
ALTER TABLE "MessageReaction"
  DROP CONSTRAINT IF EXISTS "MessageReaction_messageId_fkey",
  ADD  CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageReaction"
  DROP CONSTRAINT IF EXISTS "MessageReaction_userId_fkey",
  ADD  CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
