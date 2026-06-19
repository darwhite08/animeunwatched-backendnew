-- Waitlist table — App Runner doesn't run migrations, so create it by hand on
-- prod RDS BEFORE deploying the waitlist module (else POST /waitlist 500s).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "Waitlist" (
  "id"         TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "source"     TEXT,
  "referredBy" TEXT,
  "invited"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Waitlist_email_key" ON "Waitlist"("email");
CREATE INDEX IF NOT EXISTS "Waitlist_createdAt_idx" ON "Waitlist"("createdAt");
