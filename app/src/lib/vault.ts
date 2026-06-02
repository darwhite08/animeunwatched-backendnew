import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * Symmetric encryption helpers for the secrets vault. Uses AES-256-GCM
 * with a master key sourced from VAULT_MASTER_KEY env (must be 32 raw
 * bytes hex-encoded, i.e. 64 hex chars). In production this key should
 * itself be supplied by a real KMS — here we treat the env value as the
 * data-encryption key for the row ciphertexts.
 */

function getMasterKey(): Buffer {
  const hex = process.env.VAULT_MASTER_KEY
  if (!hex) {
    // Dev fallback — DO NOT use in production. Logged loudly.
    if (process.env.NODE_ENV === "production") {
      throw new Error("VAULT_MASTER_KEY env not set in production")
    }
    return crypto.createHash("sha256").update("dev-vault-key").digest()
  }
  const buf = Buffer.from(hex, "hex")
  if (buf.length !== 32) throw new Error("VAULT_MASTER_KEY must be 32 bytes (64 hex chars)")
  return buf
}

export interface EncryptedSecret { ciphertextB64: string; ivB64: string; authTagB64: string }

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertextB64: ct.toString("base64"),
    ivB64:         iv.toString("base64"),
    authTagB64:    tag.toString("base64"),
  }
}

export function decryptSecret(e: EncryptedSecret): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), Buffer.from(e.ivB64, "base64"))
  decipher.setAuthTag(Buffer.from(e.authTagB64, "base64"))
  const pt = Buffer.concat([decipher.update(Buffer.from(e.ciphertextB64, "base64")), decipher.final()])
  return pt.toString("utf8")
}

/** Look up a secret by name. Bumps lastReadAt. */
export async function readSecret(name: string): Promise<string | null> {
  const row = await prisma.vaultEntry.findUnique({ where: { name } })
  if (!row) return null
  const plain = decryptSecret({ ciphertextB64: row.ciphertextB64, ivB64: row.ivB64, authTagB64: row.authTagB64 })
  // Best-effort update; don't block the caller on telemetry
  prisma.vaultEntry.update({ where: { id: row.id }, data: { lastReadAt: new Date() } }).catch(() => undefined)
  return plain
}
