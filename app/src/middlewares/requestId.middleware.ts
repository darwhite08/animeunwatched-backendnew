/**
 * Per-request correlation ID middleware.
 *
 * - Reads `X-Request-ID` if the upstream proxy supplied one (App Runner does).
 * - Otherwise generates a 16-char nanoid.
 * - Exposes it on `res.locals.requestId` for downstream code to log alongside
 *   their messages, and echoes it back to the client via the same header so
 *   support can quote a request id to find the matching server log entry.
 */
import type { Request, Response, NextFunction } from "express";
import { nanoid } from "nanoid";

const HEADER = "x-request-id";

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header(HEADER);
  const id = (typeof inbound === "string" && inbound.length > 0 && inbound.length <= 64)
    ? inbound
    : nanoid(16);
  res.locals.requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
}
