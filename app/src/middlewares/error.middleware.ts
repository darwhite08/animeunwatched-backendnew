import { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/errors";
import { ZodError } from "zod";
import * as Sentry from "@sentry/node";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION",
        message: "Validation failed",
        issues: err.issues,
      },
    });
    return;
  }

  // Capture unexpected errors in Sentry (only if initialized)
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }
  console.error(err);
  res
    .status(500)
    .json({ error: { code: "INTERNAL", message: "Internal server error" } });
}
