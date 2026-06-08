-- Club-scoped polls. ADDITIVE.
ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "clubId" TEXT;
CREATE INDEX IF NOT EXISTS "Poll_clubId_idx" ON "Poll"("clubId");
DO $$ BEGIN
  ALTER TABLE "Poll" ADD CONSTRAINT "Poll_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
