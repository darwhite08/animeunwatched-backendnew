-- DM disappearing messages. ADDITIVE.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "disappearingSeconds" INTEGER;
ALTER TABLE "DirectMessage" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "DirectMessage_expiresAt_idx" ON "DirectMessage"("expiresAt");
