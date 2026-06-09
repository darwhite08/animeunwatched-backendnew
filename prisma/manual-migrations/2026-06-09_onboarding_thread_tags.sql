-- Onboarding (User.favoriteGenres/onboardedAt) + Thread.tags. ADDITIVE.
ALTER TABLE "User"   ADD COLUMN IF NOT EXISTS "favoriteGenres" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "User"   ADD COLUMN IF NOT EXISTS "onboardedAt"    TIMESTAMP(3);
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "tags"           TEXT[] NOT NULL DEFAULT '{}';
