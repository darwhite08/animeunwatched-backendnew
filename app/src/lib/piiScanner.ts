import { prisma } from "../config/prisma"

/**
 * Static catalogue of fields known to contain personal data.
 *
 * We could try to derive this from Prisma DMMF + heuristics on field names
 * (anything matching /email|phone|ip|address|name/i is likely PII), but the
 * heuristic is wrong often enough that a curated catalogue is safer for
 * compliance reporting. Admins can override classification + retention from
 * the UI; this scanner is just the seed.
 *
 * Classifications (loose mapping to GDPR Article 4 + 9):
 *   - identifier:  globally unique handle (email, username, phone)
 *   - contact:     other contact paths (oauth provider IDs, push tokens)
 *   - sensitive:   special category data (health, biometrics) — none today
 *   - behavioral:  usage data tied to a person (lists, follows, posts)
 *   - device:      device + network fingerprints (IP, UA, headers)
 */
export interface PiiSeed {
  model:          string
  field:          string
  classification: "identifier" | "contact" | "sensitive" | "behavioral" | "device"
  legalBasis:     "consent" | "contract" | "legitimate_interest" | "legal_obligation"
  retentionDays:  number | null
  readRoleMin:    "USER" | "MOD" | "ADMIN"
  description:    string
}

export const PII_SEED: PiiSeed[] = [
  // ---- User identity ----
  { model: "User", field: "email",            classification: "identifier", legalBasis: "contract",              retentionDays: null, readRoleMin: "ADMIN", description: "Primary login + comms address" },
  { model: "User", field: "username",         classification: "identifier", legalBasis: "contract",              retentionDays: null, readRoleMin: "USER",  description: "Public handle" },
  { model: "User", field: "displayName",      classification: "identifier", legalBasis: "contract",              retentionDays: null, readRoleMin: "USER",  description: "Public display name" },
  { model: "User", field: "passwordHash",     classification: "identifier", legalBasis: "contract",              retentionDays: null, readRoleMin: "ADMIN", description: "argon2 hash — never returned via API" },
  { model: "User", field: "googleId",         classification: "contact",    legalBasis: "contract",              retentionDays: null, readRoleMin: "ADMIN", description: "Google OAuth subject" },
  { model: "User", field: "appleId",          classification: "contact",    legalBasis: "contract",              retentionDays: null, readRoleMin: "ADMIN", description: "Apple OAuth subject" },
  { model: "User", field: "totpSecret",       classification: "identifier", legalBasis: "contract",              retentionDays: null, readRoleMin: "ADMIN", description: "TOTP shared secret — never returned" },
  // ---- Device + network ----
  { model: "RefreshToken",   field: "ipAddress",  classification: "device", legalBasis: "legitimate_interest", retentionDays: 90,  readRoleMin: "ADMIN", description: "IP captured at refresh-token mint" },
  { model: "RefreshToken",   field: "userAgent",  classification: "device", legalBasis: "legitimate_interest", retentionDays: 90,  readRoleMin: "ADMIN", description: "UA captured at refresh-token mint" },
  { model: "SecurityEvent",  field: "ipAddress",  classification: "device", legalBasis: "legitimate_interest", retentionDays: 90,  readRoleMin: "MOD",   description: "IP captured per auth event" },
  { model: "SecurityEvent",  field: "userAgent",  classification: "device", legalBasis: "legitimate_interest", retentionDays: 90,  readRoleMin: "MOD",   description: "UA captured per auth event" },
  { model: "AuditLog",       field: "actorIp",    classification: "device", legalBasis: "legal_obligation",    retentionDays: 365, readRoleMin: "ADMIN", description: "Admin actor IP — kept for audit" },
  { model: "AuditLog",       field: "userAgent",  classification: "device", legalBasis: "legal_obligation",    retentionDays: 365, readRoleMin: "ADMIN", description: "Admin actor UA — kept for audit" },
  { model: "IpProfile",      field: "ip",         classification: "device", legalBasis: "legitimate_interest", retentionDays: 365, readRoleMin: "MOD",   description: "IP geo cache row" },
  { model: "AnomalyEvent",   field: "ipAddress",  classification: "device", legalBasis: "legitimate_interest", retentionDays: 180, readRoleMin: "MOD",   description: "IP that triggered an anomaly" },
  // ---- Behavioral ----
  { model: "ListEntry",      field: "userId",   classification: "behavioral", legalBasis: "contract", retentionDays: null, readRoleMin: "USER", description: "Watchlist ownership" },
  { model: "Post",           field: "userId",   classification: "behavioral", legalBasis: "contract", retentionDays: null, readRoleMin: "USER", description: "Post authorship" },
  { model: "PostComment",    field: "userId",   classification: "behavioral", legalBasis: "contract", retentionDays: null, readRoleMin: "USER", description: "Comment authorship" },
  { model: "Review",         field: "userId",   classification: "behavioral", legalBasis: "contract", retentionDays: null, readRoleMin: "USER", description: "Review authorship" },
  { model: "Follow",         field: "followerId", classification: "behavioral", legalBasis: "contract", retentionDays: null, readRoleMin: "USER", description: "Social graph edge" },
  // ---- Contact channels ----
  { model: "PushSubscription", field: "endpoint", classification: "contact", legalBasis: "consent", retentionDays: null, readRoleMin: "ADMIN", description: "Web Push endpoint" },
]

/** Idempotent seed — inserts missing rows, leaves admin-edited rows alone. */
export async function seedPiiInventory(): Promise<{ added: number; existing: number }> {
  let added = 0, existing = 0
  for (const s of PII_SEED) {
    const found = await prisma.piiField.findUnique({
      where: { model_field: { model: s.model, field: s.field } },
    })
    if (found) { existing++; continue }
    await prisma.piiField.create({
      data: {
        model: s.model, field: s.field, classification: s.classification,
        legalBasis: s.legalBasis, retentionDays: s.retentionDays,
        readRoleMin: s.readRoleMin, description: s.description,
      },
    })
    added++
  }
  return { added, existing }
}
