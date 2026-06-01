/**
 * Structured JSON logger.
 *
 * Production: single-line JSON to stdout — App Runner forwards to CloudWatch
 * Logs where it can be queried with CloudWatch Insights.
 * Development: pretty-printed via pino-pretty (only if installed; falls back
 * to plain JSON otherwise).
 *
 * Sensitive fields are redacted automatically. Add to REDACT_PATHS when
 * adding any new field that contains secrets / PII.
 */
import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.token",
  "req.body.idToken",
  "req.body.ciphertext",          // E2E chat payloads
  "req.body.iv",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.ciphertext",
  "*.iv",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  base: {
    service: "kaiveron-backend",
    env:     process.env.NODE_ENV ?? "development",
    // Useful for correlating App Runner deploys to log batches
    deploy:  process.env.RENDER_GIT_COMMIT ?? process.env.AWS_APP_RUNNER_REVISION ?? "dev",
  },
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  // ISO timestamp — CloudWatch parses it cleanly
  timestamp: pino.stdTimeFunctions.isoTime,
});
