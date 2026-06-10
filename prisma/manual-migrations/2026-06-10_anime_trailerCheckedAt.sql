-- Trailer resolver bookkeeping column — missing in prod, 500s all Anime reads (browse). ADDITIVE.
ALTER TABLE "Anime" ADD COLUMN IF NOT EXISTS "trailerCheckedAt" TIMESTAMP(3);
