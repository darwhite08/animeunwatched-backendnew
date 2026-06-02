import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * OAuth 2.0 helpers — client_credentials grant only at this stage.
 * Tokens and secrets are stored as SHA-256 hashes so a DB leak can't be
 * used to mint replays. The plaintext is returned exactly once at the
 * moment of issuance.
 */

const CLIENT_ID_PREFIX     = "ka_oc_"
const CLIENT_SECRET_PREFIX = "ka_sk_"
const ACCESS_TOKEN_PREFIX  = "ka_at_"

const DEFAULT_TTL_SEC = 60 * 60   // 1 hour

export interface KnownScope { value: string; description: string }
export const KNOWN_SCOPES: KnownScope[] = [
  { value: "read:users",      description: "Read user public profiles" },
  { value: "read:anime",      description: "Read anime catalogue" },
  { value: "read:posts",      description: "Read public posts + feeds" },
  { value: "write:webhooks",  description: "Register and trigger webhooks" },
  { value: "scim",            description: "Provision users via SCIM 2.0" },
  { value: "admin:read",      description: "Read admin telemetry (stats, health)" },
]

export function isKnownScope(s: string): boolean {
  return KNOWN_SCOPES.some(k => k.value === s)
}

export function hash(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex")
}

export function generateClientId():     string { return CLIENT_ID_PREFIX     + crypto.randomBytes(16).toString("hex") }
export function generateClientSecret(): string { return CLIENT_SECRET_PREFIX + crypto.randomBytes(32).toString("hex") }
export function generateAccessToken():  string { return ACCESS_TOKEN_PREFIX  + crypto.randomBytes(32).toString("hex") }

export interface IssuedToken {
  accessToken: string                              // plaintext — return ONCE
  tokenType:   "Bearer"
  expiresIn:   number                              // seconds
  scope:       string                              // space-separated
}

/**
 * Verifies clientId + clientSecret, then mints an access token whose scopes
 * are the intersection of the requested scopes (if any) and the client's
 * registered scopes.
 */
export async function issueClientCredentialsToken(opts: {
  clientId:       string
  clientSecret:   string
  requestedScope?: string                          // space-separated, optional
  ttlSec?:        number
}): Promise<IssuedToken> {
  const client = await prisma.oauthClient.findUnique({ where: { clientId: opts.clientId } })
  if (!client)                                                       throw new OAuthError("invalid_client", "Unknown client_id")
  if (client.revokedAt)                                              throw new OAuthError("invalid_client", "Client revoked")
  if (client.clientSecretHash !== hash(opts.clientSecret))           throw new OAuthError("invalid_client", "Bad client_secret")

  const requested = (opts.requestedScope ?? "").trim()
    ? opts.requestedScope!.split(/\s+/).filter(Boolean)
    : client.scopes
  const granted = requested.filter(s => client.scopes.includes(s))
  if (granted.length === 0 && requested.length > 0) {
    throw new OAuthError("invalid_scope", "None of the requested scopes are granted to this client")
  }

  const plaintext = generateAccessToken()
  const ttl       = opts.ttlSec ?? DEFAULT_TTL_SEC
  const expiresAt = new Date(Date.now() + ttl * 1000)
  await prisma.oauthAccessToken.create({
    data: {
      clientId:  client.id,
      tokenHash: hash(plaintext),
      scopes:    granted,
      expiresAt,
    },
  })
  await prisma.oauthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } })

  return {
    accessToken: plaintext,
    tokenType:   "Bearer",
    expiresIn:   ttl,
    scope:       granted.join(" "),
  }
}

export interface VerifiedToken {
  tokenId:  string
  clientId: string
  client:   { id: string; name: string; clientId: string }
  scopes:   string[]
  expiresAt: Date
}

/**
 * Looks up an access token by hash, validates it is not expired or revoked,
 * and bumps lastUsedAt + useCount.
 */
export async function verifyAccessToken(plaintext: string): Promise<VerifiedToken> {
  const at = await prisma.oauthAccessToken.findUnique({
    where:   { tokenHash: hash(plaintext) },
    include: { client: true },
  })
  if (!at)                            throw new OAuthError("invalid_token", "Unknown token")
  if (at.revokedAt)                   throw new OAuthError("invalid_token", "Token revoked")
  if (at.expiresAt < new Date())      throw new OAuthError("invalid_token", "Token expired")
  if (at.client.revokedAt)            throw new OAuthError("invalid_token", "Client revoked")
  // Update last-used asynchronously — don't block the request path
  prisma.oauthAccessToken.update({
    where: { id: at.id },
    data:  { lastUsedAt: new Date(), useCount: { increment: 1 } },
  }).catch(() => undefined)
  return {
    tokenId:   at.id,
    clientId:  at.clientId,
    client:    { id: at.client.id, name: at.client.name, clientId: at.client.clientId },
    scopes:    at.scopes,
    expiresAt: at.expiresAt,
  }
}

export function hasScope(verified: VerifiedToken, required: string): boolean {
  return verified.scopes.includes(required)
}

/** Standard OAuth 2.0 error model (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "OAuthError"
  }
}
