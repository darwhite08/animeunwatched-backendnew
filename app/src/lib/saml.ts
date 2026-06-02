import { SAML } from "@node-saml/node-saml"
import type { SamlConfigModel as PrismaSamlConfig } from "../generated/prisma/models/SamlConfig"
import { prisma } from "../config/prisma"

/**
 * Thin wrapper around @node-saml/node-saml that translates between our
 * stored SamlConfig rows and the library's options shape. The library
 * handles all XML signing/verification — we never touch crypto directly.
 *
 * Scope of this MVP:
 *   - SP-initiated flow only (IdP-init is replay-prone and not enabled
 *     unless the IdP needs it)
 *   - Single active config at a time
 *   - Auto-provision optional — first-login users get a passwordless
 *     account similar to SCIM-provisioned ones
 */

const CACHE_TTL_MS = 5 * 60_000
let samlCache: { config: PrismaSamlConfig; instance: SAML; cachedAt: number } | null = null

export async function getActiveSamlConfig(): Promise<PrismaSamlConfig | null> {
  const c = await prisma.samlConfig.findFirst({ where: { active: true }, orderBy: { updatedAt: "desc" } })
  return c
}

/** Build (or reuse) a SAML instance from the current active config. */
export async function getActiveSaml(spBaseUrl: string): Promise<{ saml: SAML; config: PrismaSamlConfig } | null> {
  const active = await getActiveSamlConfig()
  if (!active) return null

  if (samlCache && samlCache.config.id === active.id && samlCache.config.updatedAt.getTime() === active.updatedAt.getTime()
      && Date.now() - samlCache.cachedAt < CACHE_TTL_MS) {
    return { saml: samlCache.instance, config: active }
  }

  const instance = new SAML({
    issuer:                   active.spEntityId,
    callbackUrl:              `${spBaseUrl}/saml/acs`,
    entryPoint:               active.idpSsoUrl,
    logoutUrl:                active.idpSloUrl ?? undefined,
    idpIssuer:                active.idpEntityId,
    idpCert:                  normalizeCert(active.idpCertificate),
    wantAssertionsSigned:     active.wantAssertionsSigned,
    wantAuthnResponseSigned:  true,
    signMetadata:             !!active.spCertificate,
    privateKey:               active.spPrivateKey ?? undefined,
    publicCert:               active.spCertificate ?? undefined,
    signatureAlgorithm:       "sha256",
    digestAlgorithm:          "sha256",
    identifierFormat:         "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    acceptedClockSkewMs:      30_000,
  })
  samlCache = { config: active, instance, cachedAt: Date.now() }
  return { saml: instance, config: active }
}

/** Force the next call to rebuild the SAML instance. Useful after admin edits. */
export function invalidateSamlCache(): void { samlCache = null }

/** Strip BEGIN/END lines from a PEM cert and rejoin into the format node-saml expects. */
export function normalizeCert(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
}

export interface ExtractedIdentity {
  email:        string
  displayName:  string
  nameId:       string
  externalId:   string | null
  rawAttributes: Record<string, unknown>
}

/**
 * Pull email + displayName from a verified SAML Profile, using the
 * attribute names configured on the SamlConfig row (defaults: "email",
 * "displayName"). Falls back to nameID if no email attribute is present.
 */
export function extractIdentity(profile: Record<string, unknown>, config: PrismaSamlConfig): ExtractedIdentity {
  const attrs = profile as Record<string, unknown>
  const lookup = (key: string): string | undefined => {
    if (typeof attrs[key] === "string") return attrs[key] as string
    // Many IdPs use full URIs as attribute names — try a forgiving lookup
    for (const k of Object.keys(attrs)) {
      if (k.toLowerCase().endsWith(`/${key.toLowerCase()}`) ||
          k.toLowerCase() === key.toLowerCase()) {
        const v = attrs[k]
        if (typeof v === "string") return v
        if (Array.isArray(v) && typeof v[0] === "string") return v[0]
      }
    }
    return undefined
  }
  const nameId       = String(attrs.nameID ?? attrs.nameId ?? "")
  const email        = lookup(config.emailAttribute) ?? (looksLikeEmail(nameId) ? nameId : "")
  const displayName  = lookup(config.displayNameAttr) ?? email.split("@")[0]
  const externalId   = lookup("externalId") ?? (nameId || null)

  return { email: email.trim().toLowerCase(), displayName: displayName.trim(), nameId, externalId, rawAttributes: attrs }
}

function looksLikeEmail(s: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) }
