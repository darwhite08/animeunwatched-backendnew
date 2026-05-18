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
  // Service ID (Bundle ID registered under "Sign in with Apple")
  APPLE_CLIENT_ID:   process.env.APPLE_CLIENT_ID   || "",
  // 10-char Team ID from Apple Developer account
  APPLE_TEAM_ID:     process.env.APPLE_TEAM_ID     || "",
  // Key ID of the .p8 private key
  APPLE_KEY_ID:      process.env.APPLE_KEY_ID      || "",
  // Contents of the .p8 private key file (newlines as \n)
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",
};
