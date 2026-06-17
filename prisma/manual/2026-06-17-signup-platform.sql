-- Product-analytics web/mobile attribution: User.signupPlatform.
-- App Runner does NOT run `prisma migrate` on deploy, so add this column to prod
-- RDS by hand before/at deploy or registration + the analytics queries 500.
-- (Open the RDS security group to your IP, run, then revoke.) Idempotent.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "signupPlatform" text;

-- Existing rows stay NULL (bucketed as "unknown" in the admin). New signups are
-- stamped "web" | "mobile" | "unknown" by the register flow going forward.
