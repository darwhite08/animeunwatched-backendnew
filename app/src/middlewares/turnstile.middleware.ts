import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

/**
 * Cloudflare Turnstile verification middleware.
 *
 * Activated only when `TURNSTILE_SECRET` is set in the environment. Until
 * then this middleware is a no-op so deploys don't break before the
 * Cloudflare account is provisioned.
 *
 * Frontend sends the token in the JSON body as `turnstileToken`. We POST
 * it to Cloudflare's `siteverify` endpoint along with the requester IP
 * for binding. A failed verification returns 403 with code TURNSTILE_FAIL.
 *
 * Mount on sensitive write endpoints: POST /auth/register, POST /posts,
 * POST /posts/:id/comments.
 */
export function turnstile() {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const token = (req.body && typeof req.body === "object")
      ? (req.body as Record<string, unknown>).turnstileToken
      : undefined;

    if (typeof token !== "string" || token.length === 0) {
      res.status(403).json({
        error: { code: "TURNSTILE_REQUIRED", message: "Captcha token missing" },
      });
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      .trim() ?? req.ip;

    try {
      const params = new URLSearchParams({ secret, response: token });
      if (ip) params.set("remoteip", ip);

      const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method:  "POST",
        body:    params,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal:  AbortSignal.timeout(4000),
      });

      const data = await r.json() as {
        success: boolean
        "error-codes"?: string[]
        hostname?: string
        challenge_ts?: string
      };

      if (!data.success) {
        logger.warn({
          turnstile: { errors: data["error-codes"] ?? [], ip, path: req.path },
        }, "turnstile verification failed");

        res.status(403).json({
          error: { code: "TURNSTILE_FAIL", message: "Captcha verification failed" },
        });
        return;
      }

      // Strip the token from the body so downstream handlers don't see it
      delete (req.body as Record<string, unknown>).turnstileToken;
      next();
    } catch (err: unknown) {
      logger.error({ err, path: req.path }, "turnstile siteverify request failed");
      // Soft-fail closed: drop the request rather than letting spam through
      // when Cloudflare is unreachable. If this becomes a reliability issue,
      // swap to "fail open" by calling next() here instead.
      res.status(503).json({
        error: { code: "TURNSTILE_UNAVAILABLE", message: "Captcha service unavailable, please retry" },
      });
    }
  };
}
