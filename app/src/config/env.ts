import dotenv from "dotenv";
dotenv.config();

export const env = {
  PORT: Number(process.env.PORT) || 4000,
  NODE_ENV: process.env.NODE_ENV || "development",
  DATABASE_URL: process.env.DATABASE_URL || "",
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || "dev-access-secret",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || "15m",
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || "7d",
  JIKAN_BASE_URL: process.env.JIKAN_BASE_URL || "https://api.jikan.moe/v4",
  CATALOG_PROVIDER: (process.env.CATALOG_PROVIDER || "jikan") as
    | "jikan"
    | "mal"
    | "anilist",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:3000",
};
