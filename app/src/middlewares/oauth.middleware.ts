import type { Request, Response, NextFunction } from "express"
import { verifyAccessToken, hasScope, OAuthError } from "../lib/oauth2"

/**
 * OAuth Bearer-token middleware. Reads the Authorization header, validates
 * the token, and pins the verified token onto res.locals.oauth. Optionally
 * enforces a required scope.
 *
 * Note: this is for SERVER-TO-SERVER calls — separate from the user JWT
 * (requireAuth). A route can mount both: requireOauth gives you the calling
 * app; requireAuth gives you the calling user. Most third-party calls use
 * one or the other, not both.
 */
export function requireOauth(opts: { scope?: string } = {}) {
  return async function oauthGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const auth = req.header("Authorization") ?? ""
      const match = /^Bearer\s+(\S+)/i.exec(auth)
      if (!match) {
        res.setHeader("WWW-Authenticate", 'Bearer error="invalid_request"')
        return sendOauthError(res, "invalid_request", "Bearer token required", 401)
      }
      const verified = await verifyAccessToken(match[1])
      if (opts.scope && !hasScope(verified, opts.scope)) {
        res.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope" scope="${opts.scope}"`)
        return sendOauthError(res, "insufficient_scope", `Required scope: ${opts.scope}`, 403)
      }
      ;(res.locals as Record<string, unknown>).oauth = verified
      next()
    } catch (err) {
      if (err instanceof OAuthError) {
        res.setHeader("WWW-Authenticate", `Bearer error="${err.code}"`)
        return sendOauthError(res, err.code, err.message, 401)
      }
      next(err)
    }
  }
}

function sendOauthError(res: Response, code: string, description: string, status: number): void {
  res.status(status).json({ error: code, error_description: description })
}
