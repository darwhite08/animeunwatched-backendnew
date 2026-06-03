-- ============================================================================
-- Native (Capacitor FCM/APNs) push tokens — ADDITIVE, no data loss. REVIEW before prod.
-- Separate from DeviceToken (Expo) because token formats + send paths differ.
-- Apply: `npx prisma db push`  OR  run this script via psql.
-- Reversible: DROP TABLE "NativePushToken";
-- ============================================================================
CREATE TABLE IF NOT EXISTS "NativePushToken" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "platform"   TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NativePushToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "NativePushToken_token_key" ON "NativePushToken"("token");
CREATE INDEX IF NOT EXISTS "NativePushToken_userId_idx" ON "NativePushToken"("userId");
ALTER TABLE "NativePushToken"
  DROP CONSTRAINT IF EXISTS "NativePushToken_userId_fkey",
  ADD  CONSTRAINT "NativePushToken_userId_fkey"
       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
