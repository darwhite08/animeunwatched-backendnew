import { Router } from "express"
import type { Request, Response } from "express"
import crypto from "node:crypto"
import { prisma } from "../../config/prisma"
import { getActiveSaml, extractIdentity } from "../../lib/saml"
import { issueRefreshTokenForUser, signAccessToken } from "../auth/auth.service"

export const samlRouter = Router()

const FRONTEND_BASE = process.env.FRONTEND_URL ?? "https://kaiveron.com"

/**
 * Constrain the post-login redirect target to a SAME-SITE RELATIVE PATH.
 * `returnTo` is attacker-controllable at /saml/login (it round-trips through
 * RelayState), and the ACS appends the freshly-minted access token to the URL
 * fragment — so an absolute/off-origin value is a token-exfiltration open
 * redirect. Only allow paths that start with a single "/" (not "//" or "/\"),
 * with no scheme/authority; everything else falls back to "/".
 */
function safeReturnPath(returnTo: unknown): string {
  if (typeof returnTo !== "string") return "/"
  if (!returnTo.startsWith("/")) return "/"     // reject absolute http(s):// etc.
  if (/^\/[/\\]/.test(returnTo)) return "/"     // reject protocol-relative //evil and /\evil
  if (/[\r\n]/.test(returnTo)) return "/"       // header/Location injection guard
  return returnTo
}

function baseUrlFor(req: Request): string {
  const proto = (req.header("X-Forwarded-Proto") ?? req.protocol).split(",")[0].trim()
  const host  = req.header("X-Forwarded-Host") ?? req.header("Host") ?? "localhost"
  return `${proto}://${host}`
}

// --- Metadata -----------------------------------------------------------

/**
 * GET /saml/metadata — Service Provider metadata XML. Hand this to the
 * IdP admin to register Kaiveron as a SAML SP.
 */
samlRouter.get("/metadata", async (req, res) => {
  try {
    const active = await getActiveSaml(baseUrlFor(req))
    if (!active) { res.status(404).type("text/plain").send("No active SAML config"); return }
    const xml = active.saml.generateServiceProviderMetadata(
      active.config.spCertificate ?? null,
      active.config.spCertificate ?? null,
    )
    res.status(200).type("application/xml").send(xml)
  } catch (err) {
    console.error("[saml/metadata] failed:", err)
    res.status(500).type("text/plain").send("Failed to generate metadata")
  }
})

// --- SP-initiated login --------------------------------------------------

/**
 * GET /saml/login?returnTo=/foo — kicks off SP-initiated SSO. Redirects
 * the browser to the IdP's SSO URL with an AuthnRequest. The returnTo
 * is carried through the RelayState parameter back to /saml/acs.
 */
samlRouter.get("/login", async (req, res) => {
  try {
    const active = await getActiveSaml(baseUrlFor(req))
    if (!active) { res.status(404).type("text/plain").send("SSO not configured"); return }
    // Normalize to a same-site path at entry too (defense-in-depth; the ACS
    // re-validates regardless).
    const returnTo = safeReturnPath(req.query.returnTo)
    // RelayState is opaque to the IdP; we sign it lightly so we don't trust the round-tripped value blindly
    const state = encodeRelayState(returnTo)
    const url   = await active.saml.getAuthorizeUrlAsync(state, undefined, {})
    res.redirect(url)
  } catch (err) {
    console.error("[saml/login] failed:", err)
    res.status(500).type("text/plain").send("Failed to start SSO")
  }
})

// --- Assertion consumer --------------------------------------------------

/**
 * POST /saml/acs — Assertion Consumer Service. The IdP POSTs the
 * SAMLResponse here. We verify the signature, extract the user identity,
 * provision or look up the local User, mint our normal access+refresh
 * tokens, and redirect the browser back to the frontend with the access
 * token in the URL fragment.
 */
samlRouter.post("/acs", async (req, res) => {
  const startedAt = Date.now()
  let outcome = "unknown_failure"
  let userId: string | undefined
  let configId: string | undefined
  let email: string | undefined

  try {
    const base   = baseUrlFor(req)
    const active = await getActiveSaml(base)
    if (!active) { res.status(404).type("text/plain").send("SSO not configured"); return }
    configId = active.config.id

    const body = (req.body ?? {}) as Record<string, string>
    if (!body.SAMLResponse) {
      outcome = "missing_response"
      res.status(400).type("text/plain").send("Missing SAMLResponse")
      return
    }

    const result = await active.saml.validatePostResponseAsync(body).catch((err: Error) => {
      throw new SamlVerificationError(err.message)
    })
    if (!result.profile) {
      outcome = "verification_failed"
      res.status(401).type("text/plain").send("Invalid SAML response")
      return
    }

    const id = extractIdentity(result.profile as unknown as Record<string, unknown>, active.config)
    email = id.email
    if (!id.email) {
      outcome = "missing_email"
      res.status(400).type("text/plain").send("SAML assertion missing required email attribute")
      return
    }

    // Find or provision
    let user = await prisma.user.findUnique({ where: { email: id.email } })
    if (!user) {
      if (!active.config.autoProvision) {
        outcome = "rejected_provision"
        res.status(403).type("text/plain").send("No account exists for this user; auto-provisioning is disabled")
        return
      }
      const username = await pickAvailableUsername(id.email.split("@")[0])
      user = await prisma.user.create({
        data: {
          email:        id.email,
          username,
          displayName:  id.displayName || username,
          passwordHash: "saml_provisioned:" + crypto.randomBytes(48).toString("hex"),
        },
      })
    }
    userId = user.id

    // Mint our normal tokens — reuse the existing auth pipeline so this user
    // looks identical to any other from here on
    const ip = readIp(req)
    const ua = req.header("User-Agent")?.slice(0, 500)
    const refreshToken = await issueRefreshTokenForUser(user.id, { ip, userAgent: ua })
    const accessToken  = signAccessToken(user.id)

    outcome = "success"

    // Set httpOnly refresh cookie with the SAME name + scoping as the main auth
    // flow (was "refreshToken" at path "/", which both over-broadened the send
    // scope AND was never read by the refresh endpoint, which expects aw_refresh
    // scoped to /api/v1/auth).
    res.cookie("aw_refresh", refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      path:     "/api/v1/auth",
      maxAge:   7 * 24 * 60 * 60_000,
      ...(process.env.NODE_ENV === "production" ? { domain: ".kaiveron.com" } : {}),
    })
    // Always build the redirect from our OWN origin + a validated same-site
    // path — never trust returnTo as an absolute URL (token-leak open redirect).
    const returnTo = safeReturnPath(decodeRelayState(body.RelayState))
    const redirectUrl = new URL(FRONTEND_BASE + returnTo)
    redirectUrl.hash = `accessToken=${encodeURIComponent(accessToken)}&via=saml`
    res.redirect(302, redirectUrl.toString())
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (err instanceof SamlVerificationError) outcome = "verification_failed"
    console.error(`[saml/acs] ${outcome}:`, detail)
    if (!res.headersSent) res.status(401).type("text/plain").send("SAML verification failed")
  } finally {
    // Always log the attempt
    void prisma.samlLoginEvent.create({
      data: {
        configId:    configId ?? "unknown",
        userId:      userId ?? null,
        email:       email ?? null,
        outcome,
        ipAddress:   readIp(req),
        userAgent:   req.header("User-Agent")?.slice(0, 500),
      },
    }).catch(() => undefined)
    void prisma.samlConfig.update({ where: { id: configId ?? "" }, data: { updatedAt: new Date() } }).catch(() => undefined)
    if (process.env.NODE_ENV !== "production") {
      console.log(`[saml/acs] outcome=${outcome} userId=${userId} took=${Date.now() - startedAt}ms`)
    }
  }
})

// --- Helpers ------------------------------------------------------------

class SamlVerificationError extends Error {}

// RelayState HMAC key. In production the JWT secret MUST exist; the "dev"
// fallback is dev-only (and the open-redirect is independently closed by
// safeReturnPath, so a forged RelayState can only yield a same-site path).
const RELAY_SECRET = process.env.JWT_ACCESS_SECRET
  ?? (process.env.NODE_ENV === "production"
      ? (() => { throw new Error("JWT_ACCESS_SECRET required for SAML RelayState signing") })()
      : "dev")
function encodeRelayState(returnTo: string): string {
  const sig = crypto.createHmac("sha256", RELAY_SECRET).update(returnTo).digest("hex").slice(0, 16)
  return Buffer.from(`${sig}:${returnTo}`, "utf8").toString("base64url")
}
function decodeRelayState(s: string | undefined): string | null {
  if (!s) return null
  try {
    const decoded = Buffer.from(s, "base64url").toString("utf8")
    const idx = decoded.indexOf(":")
    if (idx < 0) return null
    const sig = decoded.slice(0, idx)
    const returnTo = decoded.slice(idx + 1)
    const expected = crypto.createHmac("sha256", RELAY_SECRET).update(returnTo).digest("hex").slice(0, 16)
    if (sig !== expected) return null
    return returnTo
  } catch { return null }
}

function readIp(req: Request): string | undefined {
  const fwd = req.header("X-Forwarded-For")
  return fwd ? fwd.split(",")[0].trim() : req.ip
}

async function pickAvailableUsername(seed: string): Promise<string> {
  const base = seed.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 24) || "user"
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}_${Math.random().toString(36).slice(2, 6)}`
    const taken = await prisma.user.findUnique({ where: { username: candidate } })
    if (!taken) return candidate
  }
  return `${base}_${crypto.randomBytes(4).toString("hex")}`
}
