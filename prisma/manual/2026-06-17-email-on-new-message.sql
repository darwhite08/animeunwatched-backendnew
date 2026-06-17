-- Email-on-new-message feature (offline DM notifications).
-- App Runner does NOT run `prisma migrate` on deploy, so these columns must be
-- added to prod RDS by hand BEFORE/at deploy or the affected queries 500.
-- (Open the RDS security group to your IP, run, then revoke.)
-- Idempotent: safe to run more than once.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailOnNewMessage"  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "lastMessageEmailAt" timestamp(3);

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "p1LastEmailedAt" timestamp(3),
  ADD COLUMN IF NOT EXISTS "p2LastEmailedAt" timestamp(3);
