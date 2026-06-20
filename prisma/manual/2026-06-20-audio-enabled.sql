-- Feed (Shots) audio preference, per-member, synced across devices.
-- App Runner doesn't migrate — add by hand before deploy. Idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "audioEnabled" BOOLEAN NOT NULL DEFAULT false;
