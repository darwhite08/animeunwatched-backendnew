-- ============================================================================
-- DM E2EE layer — WebAuthn-PRF passkeys + per-device envelopes. ADDITIVE.
-- Apply before deploying the E2EE-enabled backend (E2EE_ENABLED flag gates use).
-- New env vars required in App Runner: SERVER_FRANK_SECRET, WEBAUTHN_RP_ID,
-- WEBAUTHN_ORIGIN (and E2EE_ENABLED=true to switch the flag on).
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "KeyWrapMethod" AS ENUM ('PASSKEY_PRF', 'RECOVERY_CODE', 'FALLBACK_PASSPHRASE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DirectMessage E2EE columns (dual-read: legacy rows keep body, E2EE rows use ciphertext)
ALTER TABLE "DirectMessage"
  ADD COLUMN IF NOT EXISTS "contentIv"   TEXT,
  ADD COLUMN IF NOT EXISTS "frankingTag" TEXT,
  ADD COLUMN IF NOT EXISTS "serverFrank" TEXT,
  ADD COLUMN IF NOT EXISTS "isE2EE"      BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "UserMasterKeyWrap" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "method"       "KeyWrapMethod" NOT NULL,
  "credentialId" TEXT,
  "wrappedUMK"   TEXT NOT NULL,
  "wrapIv"       TEXT NOT NULL,
  "kdfSalt"      TEXT,
  "kdfParams"    JSONB,
  "label"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"   TIMESTAMP(3),
  CONSTRAINT "UserMasterKeyWrap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserMasterKeyWrap_userId_credentialId_key" ON "UserMasterKeyWrap"("userId","credentialId");
CREATE INDEX IF NOT EXISTS "UserMasterKeyWrap_userId_idx" ON "UserMasterKeyWrap"("userId");
DO $$ BEGIN
  ALTER TABLE "UserMasterKeyWrap" ADD CONSTRAINT "UserMasterKeyWrap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "UserDevice" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "publicKey"      TEXT NOT NULL,
  "wrappedPrivKey" TEXT NOT NULL,
  "wrapIv"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "revoked"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "UserDevice_userId_revoked_idx" ON "UserDevice"("userId","revoked");
DO $$ BEGIN
  ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MessageEnvelope" (
  "id"           TEXT NOT NULL,
  "messageId"    TEXT NOT NULL,
  "deviceId"     TEXT NOT NULL,
  "ephemeralPub" TEXT NOT NULL,
  "wrappedCK"    TEXT NOT NULL,
  "wrapIv"       TEXT NOT NULL,
  CONSTRAINT "MessageEnvelope_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MessageEnvelope_messageId_deviceId_key" ON "MessageEnvelope"("messageId","deviceId");
CREATE INDEX IF NOT EXISTS "MessageEnvelope_deviceId_idx" ON "MessageEnvelope"("deviceId");
DO $$ BEGIN
  ALTER TABLE "MessageEnvelope" ADD CONSTRAINT "MessageEnvelope_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MessageEnvelope" ADD CONSTRAINT "MessageEnvelope_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "UserDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "WebAuthnCredential" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey"    TEXT NOT NULL,
  "counter"      INTEGER NOT NULL DEFAULT 0,
  "transports"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");
CREATE INDEX IF NOT EXISTS "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");
