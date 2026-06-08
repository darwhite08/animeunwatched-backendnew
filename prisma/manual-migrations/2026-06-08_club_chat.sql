-- Club chat: link a Club to a backing GroupConversation. ADDITIVE.
ALTER TABLE "GroupConversation" ADD COLUMN IF NOT EXISTS "clubId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "GroupConversation_clubId_key" ON "GroupConversation"("clubId");
DO $$ BEGIN
  ALTER TABLE "GroupConversation"
    ADD CONSTRAINT "GroupConversation_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
