import dotenv from "dotenv";
dotenv.config();

export const env = {
  PORT:               Number(process.env.PORT) || 4000,
  NODE_ENV:           process.env.NODE_ENV || "development",
  DATABASE_URL:       process.env.DATABASE_URL || "",
  JWT_ACCESS_SECRET:  process.env.JWT_ACCESS_SECRET  || "dev-access-secret",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
  JWT_ACCESS_EXPIRY:  process.env.JWT_ACCESS_EXPIRY  || "15m",
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || "7d",
  JIKAN_BASE_URL:     process.env.JIKAN_BASE_URL     || "https://api.jikan.moe/v4",
  // Sustained Jikan request rate (token bucket, burst 3). Jikan allows 3/sec;
  // we stay conservative at 1/sec.
  JIKAN_RATE_PER_SEC: Number(process.env.JIKAN_RATE_PER_SEC) || 1,
  // Anime sync refresh windows (see jobs/animeSync.worker.ts)
  ANIME_SYNC_HOT_INTERVAL_HOURS: Number(process.env.ANIME_SYNC_HOT_INTERVAL_HOURS) || 6,
  ANIME_SYNC_NORMAL_DAYS:        Number(process.env.ANIME_SYNC_NORMAL_DAYS)        || 7,
  ANIME_SYNC_COLD_DAYS:          Number(process.env.ANIME_SYNC_COLD_DAYS)          || 30,
  CATALOG_PROVIDER:   (process.env.CATALOG_PROVIDER  || "jikan") as "jikan" | "mal" | "anilist",
  CORS_ORIGIN:        process.env.CORS_ORIGIN        || "http://localhost:3000",
  FRONTEND_URL:       process.env.FRONTEND_URL       || "http://localhost:3000",

  // Google OAuth — https://console.cloud.google.com/
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  // Public HTTPS base URL for OAuth callbacks.
  // Required for cross-device login (mobile etc.) — use ngrok: `ngrok http 4000`
  // then set this to the ngrok URL, e.g. https://abc123.ngrok-free.app
  OAUTH_CALLBACK_BASE:  process.env.OAUTH_CALLBACK_BASE  || "",

  // Apple Sign In — https://developer.apple.com/
  APPLE_CLIENT_ID:   process.env.APPLE_CLIENT_ID   || "",
  APPLE_TEAM_ID:     process.env.APPLE_TEAM_ID     || "",
  APPLE_KEY_ID:      process.env.APPLE_KEY_ID      || "",
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",

  // Email (nodemailer / SendGrid)
  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  ENABLE_EMAIL_NOTIFICATIONS: process.env.ENABLE_EMAIL_NOTIFICATIONS === "true",

  // Cron security — all cron endpoints require this secret in x-cron-secret header
  CRON_SECRET: process.env.CRON_SECRET || "",

  // Expo Push — optional; works on free tier without an access token
  EXPO_ACCESS_TOKEN: process.env.EXPO_ACCESS_TOKEN || "",

  // Cloudflare R2 (S3-compatible) for avatar / image uploads.
  // R2_ENDPOINT is `https://<accountid>.r2.cloudflarestorage.com`
  // R2_PUBLIC_URL is your custom domain or `https://pub-<hash>.r2.dev` (after enabling Public access)
  R2_ENDPOINT:          process.env.R2_ENDPOINT          || "",
  R2_ACCESS_KEY_ID:     process.env.R2_ACCESS_KEY_ID     || "",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET:            process.env.R2_BUCKET            || "",
  R2_PUBLIC_URL:        process.env.R2_PUBLIC_URL        || "",

  // Native AWS S3 — takes precedence over R2 when set.
  // Credentials come from the App Runner instance role in prod, or from
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for local dev.
  S3_BUCKET:     process.env.S3_BUCKET     || "",
  S3_REGION:     process.env.S3_REGION     || "us-east-1",
  S3_PUBLIC_URL: process.env.S3_PUBLIC_URL || "",

  // OpenAI for /ai/ask — optional; falls back to stub responses if not set
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",

  // DM E2EE layer (addendum spec). SERVER_FRANK_SECRET signs franking tags so
  // reported plaintext is non-forgeable. WebAuthn RP id/origin for passkeys.
  // E2EE_ENABLED is the rollout flag (off → DMs stay server-readable v2).
  SERVER_FRANK_SECRET: process.env.SERVER_FRANK_SECRET || "",
  WEBAUTHN_RP_ID:      process.env.WEBAUTHN_RP_ID      || "kaiveron.com",
  WEBAUTHN_ORIGIN:     process.env.WEBAUTHN_ORIGIN     || "https://kaiveron.com",
  E2EE_ENABLED:        (process.env.E2EE_ENABLED || "false") === "true",
};

// ── Production startup guard ─────────────────────────────────────────────────
// Fail fast if critical env vars are missing or still set to weak defaults.
if (env.NODE_ENV === "production") {
  const REQUIRED: (keyof typeof env)[] = ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "CORS_ORIGIN"];
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars in production: ${missing.join(", ")}`);
    process.exit(1);
  }

  const WEAK = ["dev-access-secret", "dev-refresh-secret", "change-me-access-secret-min-32-chars", "change-me-refresh-secret-min-32-chars"];
  if (WEAK.includes(env.JWT_ACCESS_SECRET) || WEAK.includes(env.JWT_REFRESH_SECRET)) {
    console.error("[FATAL] JWT secrets must not use default dev values in production.");
    process.exit(1);
  }
}
