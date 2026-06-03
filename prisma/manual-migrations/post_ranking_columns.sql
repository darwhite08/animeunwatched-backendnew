-- Restore Post ranking columns the trending-v2 / admin-boost feature expects.
-- Additive + idempotent: existing rows default to 1.0 (neutral), no data loss.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "manualBoost"   DOUBLE PRECISION NOT NULL DEFAULT 1.0;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "shadowPenalty" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
