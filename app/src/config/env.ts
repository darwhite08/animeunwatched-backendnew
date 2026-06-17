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

  // ── Trending: off-platform web buzz signals (docs/trending-algorithm.md §11b) ──
  // AniList TRENDING_DESC feed (real-time community activity) + Wikimedia pageviews
  // (general public interest). Both free; disable either by flag. UA required by Wikimedia.
  TRENDING_ANILIST_ENABLED:   (process.env.TRENDING_ANILIST_ENABLED   ?? "true") === "true",
  TRENDING_WIKIPEDIA_ENABLED: (process.env.TRENDING_WIKIPEDIA_ENABLED ?? "true") === "true",
  TRENDING_USER_AGENT:        process.env.TRENDING_USER_AGENT || "KaiveronBot/1.0 (https://kaiveron.com; info@athavita.com)",

  CATALOG_PROVIDER:   (process.env.CATALOG_PROVIDER  || "jikan") as "jikan" | "mal" | "anilist",
  CORS_ORIGIN:        process.env.CORS_ORIGIN        || "http://localhost:3000",
  FRONTEND_URL:       process.env.FRONTEND_URL       || "http://localhost:3000",
  // Public base URL of this API — used to build one-click unsubscribe links.
  API_URL:            process.env.API_URL            || "https://api.kaiveron.com",

  // Google OAuth — https://console.cloud.google.com/
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  // Public HTTPS base URL for OAuth callbacks.
  // Required for cross-device login (mobile etc.) — use ngrok: `ngrok http 4000`
  // then set this to the ngrok URL, e.g. https://abc123.ngrok-free.app
  OAUTH_CALLBACK_BASE:  process.env.OAUTH_CALLBACK_BASE  || "",

  // Instagram (Meta) — connect creator IG accounts + import Reels into Shots.
  // Create a Meta app → Instagram API; needs a Business/Creator IG account.
  // Inert until APP_ID + APP_SECRET are set. Redirect URI defaults to the API host.
  INSTAGRAM_APP_ID:      process.env.INSTAGRAM_APP_ID      || "",
  INSTAGRAM_APP_SECRET:  process.env.INSTAGRAM_APP_SECRET  || "",
  INSTAGRAM_REDIRECT_URI: process.env.INSTAGRAM_REDIRECT_URI || "",
  INSTAGRAM_SCOPES:      process.env.INSTAGRAM_SCOPES      || "",
  // TikTok (Login Kit) — connect + import TikTok videos as embedded Shots.
  // Needs a TikTok developer app with the video.list scope + app review.
  TIKTOK_CLIENT_KEY:     process.env.TIKTOK_CLIENT_KEY     || "",
  TIKTOK_CLIENT_SECRET:  process.env.TIKTOK_CLIENT_SECRET  || "",
  TIKTOK_REDIRECT_URI:   process.env.TIKTOK_REDIRECT_URI   || "",
  // Where to bounce the creator back to after connecting (the studio).
  CREATOR_STUDIO_URL:    process.env.CREATOR_STUDIO_URL    || "https://creator-studio.kaiveron.com",

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
  // The visible From address (e.g. "no-reply@kaiveron.com"). Required by
  // providers like Resend where SMTP_USER is a literal ("resend"), not an email.
  // Falls back to SMTP_USER for plain mailbox-style SMTP.
  EMAIL_FROM: process.env.EMAIL_FROM || "",
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

  // ── Creator monetization payments (Phase 2). Inert until set: monetization
  // payment endpoints 503 with "payments not configured" when STRIPE is absent.
  STRIPE_SECRET_KEY:      process.env.STRIPE_SECRET_KEY      || "",
  STRIPE_WEBHOOK_SECRET:  process.env.STRIPE_WEBHOOK_SECRET  || "",
  STRIPE_CONNECT_RETURN_URL: process.env.STRIPE_CONNECT_RETURN_URL || "https://creator-studio.kaiveron.com/settings",
  STRIPE_CHECKOUT_SUCCESS_URL: process.env.STRIPE_CHECKOUT_SUCCESS_URL || "https://kaiveron.com",
  // Secondary payout rail for countries Stripe Connect can't pay out to
  // (notably India/Japan). Optional; PayPal Payouts when present.
  PAYPAL_CLIENT_ID:     process.env.PAYPAL_CLIENT_ID     || "",
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || "",

  // DM E2EE layer (addendum spec). SERVER_FRANK_SECRET signs franking tags so
  // reported plaintext is non-forgeable. WebAuthn RP id/origin for passkeys.
  // E2EE_ENABLED is the rollout flag (off → DMs stay server-readable v2).
  SERVER_FRANK_SECRET: process.env.SERVER_FRANK_SECRET || "",
  WEBAUTHN_RP_ID:      process.env.WEBAUTHN_RP_ID      || "kaiveron.com",
  WEBAUTHN_ORIGIN:     process.env.WEBAUTHN_ORIGIN     || "https://kaiveron.com",
  E2EE_ENABLED:        (process.env.E2EE_ENABLED || "false") === "true",

  // GIF search proxy (Tenor). Picker degrades to empty when unset.
  TENOR_API_KEY:       process.env.TENOR_API_KEY || "",
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
