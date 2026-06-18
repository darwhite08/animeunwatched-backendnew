-- Per-user geo from IP (no GPS): User.country (ISO-2) + region (state).
-- App Runner doesn't run prisma migrate; add to prod before/at deploy. Idempotent.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "country" text,
  ADD COLUMN IF NOT EXISTS "region"  text;
