-- Community Lead role: User.communityLead + communityLeadAt.
-- App Runner doesn't run prisma migrate; add to prod RDS before/at deploy or the
-- (now communityLead-carrying) user selects 500. Idempotent.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "communityLead"   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "communityLeadAt" timestamp(3);
