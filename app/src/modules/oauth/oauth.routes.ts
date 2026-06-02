import { Router } from "express"
import type { Request, Response } from "express"
import { issueClientCredentialsToken, OAuthError } from "../../lib/oauth2"
import { requireOauth } from "../../middlewares/oauth.middleware"

export const oauthRouter = Router()

/**
 * POST /oauth/token — client_credentials grant (RFC 6749 §4.4).
 *
 * Accepts:
 *   - application/x-www-form-urlencoded  (per spec)
 *   - application/json                   (modern client convenience)
 *   - HTTP Basic auth with client_id:client_secret
 *   - client_id + client_secret in the body
 *
 * Returns RFC 6749 §5.1 token response or §5.2 error.
 */
oauthRouter.post("/token", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const grantType = String(body.grant_type ?? "")
    if (grantType !== "client_credentials") {
      return sendErr(res, 400, "unsupported_grant_type", `grant_type must be "client_credentials"`)
    }

    let clientId = typeof body.client_id === "string" ? body.client_id : undefined
    let clientSecret = typeof body.client_secret === "string" ? body.client_secret : undefined
    const basic = parseBasicAuth(req.header("Authorization"))
    if (basic) { clientId = basic.id; clientSecret = basic.secret }
    if (!clientId || !clientSecret) {
      return sendErr(res, 400, "invalid_request", "client_id + client_secret required")
    }

    const requestedScope = typeof body.scope === "string" ? body.scope : undefined
    const issued = await issueClientCredentialsToken({ clientId, clientSecret, requestedScope })
    res.status(200).json({
      access_token: issued.accessToken,
      token_type:   issued.tokenType,
      expires_in:   issued.expiresIn,
      scope:        issued.scope,
    })
  } catch (err) {
    if (err instanceof OAuthError) return sendErr(res, err.status, err.code, err.message)
    console.error("[oauth/token] failed:", err)
    sendErr(res, 500, "server_error", "Unexpected error")
  }
})

function sendErr(res: Response, status: number, code: string, description: string): void {
  res.status(status).json({ error: code, error_description: description })
}

/**
 * GET /oauth/introspect — RFC 7662 §2.1 style self-introspection. Returns
 * what the verified Bearer token resolves to. Useful for partners to verify
 * their setup is correct ("do my credentials work? what scopes do I have?")
 * and as the canonical example of how to gate a route with requireOauth().
 */
oauthRouter.get("/introspect", requireOauth(), (_req: Request, res: Response) => {
  const verified = (res.locals as { oauth: { client: { id: string; name: string; clientId: string }; scopes: string[]; expiresAt: Date } }).oauth
  res.status(200).json({
    active:     true,
    client_id:  verified.client.clientId,
    client_name: verified.client.name,
    scope:      verified.scopes.join(" "),
    exp:        Math.floor(verified.expiresAt.getTime() / 1000),
    token_type: "Bearer",
  })
})

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (!header) return null
  const m = /^Basic\s+(.+)$/.exec(header)
  if (!m) return null
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8")
    const idx = decoded.indexOf(":")
    if (idx < 1) return null
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) }
  } catch { return null }
}
