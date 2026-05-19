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
