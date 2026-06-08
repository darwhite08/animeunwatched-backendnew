-- Verified badges: admin-granted on users (USER/CREATOR/STUDIO) and clubs. ADDITIVE.

DO $$ BEGIN
  CREATE TYPE "VerificationKind" AS ENUM ('USER', 'CREATOR', 'STUDIO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verifiedKind" "VerificationKind";
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verifiedAt"   TIMESTAMP(3);

ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "verified"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
