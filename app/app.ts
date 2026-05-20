import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { env } from "./src/config/env";
import { errorHandler } from "./src/middlewares/error.middleware";
import { rateLimit } from "./src/middlewares/rateLimit.middleware";
import { responseTime, requestLogger } from "./src/middlewares/performance.middleware";
import { apiVersionHeader } from "./src/middlewares/apiVersion.middleware";
import router from "./src/routes";
import { spec } from "./src/openapi";
import { prisma } from "./src/config/prisma";
import { cache } from "./src/lib/cache";

const app = express();

// Trust Render/cloud reverse proxy so req.protocol reflects https correctly
app.set("trust proxy", 1);

const ALLOWED_ORIGINS = [
  env.CORS_ORIGIN,
  env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://animeunwatched-frontend-delta.vercel.app",
].filter(Boolean)

function isVercelPreviewOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname.endsWith(".vercel.app")
  } catch { return false }
}

// Accept any local-network origin so phones on the same WiFi can log in
function isLocalNetworkOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return (
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
    )
  } catch { return false }
}

// Security headers — must come first
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
}));

app.use(responseTime);
app.use(requestLogger);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (origin && (isLocalNetworkOrigin(origin) || isVercelPreviewOrigin(origin)))) {
      callback(null, true)
    } else {
      callback(new Error("Not allowed by CORS"))
    }
  },
  credentials: true,
}));
// 1 MB payload limit to prevent large body DoS
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(apiVersionHeader);

// Rate limiting — disabled in development (all requests share 127.0.0.1)
if (env.NODE_ENV === "production") {
  // Global: 200 req/min per IP
  app.use(rateLimit(200, 60_000));

  // Auth write endpoints (login/register): strict brute-force protection
  app.use("/api/v1/auth/login",    rateLimit(10, 15 * 60_000));
  app.use("/api/v1/auth/register", rateLimit(10, 15 * 60_000));

  // Auth read/session endpoints (refresh, me, logout): relaxed
  app.use("/api/v1/auth", rateLimit(120, 60_000));
}

// Health check
app.get("/health", async (_req, res) => {
  const start = Date.now();
  let dbStatus = "ok";
  let dbLatencyMs = 0;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = "error";
  }
  res.json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    db: { status: dbStatus, latencyMs: dbLatencyMs },
    cache: { size: cache.size },
    ts: new Date().toISOString(),
  });
});

// Detailed health check
app.get("/api/v1/health/detailed", async (_req, res) => {
  const checks = {
    api: "ok",
    cache: { status: "ok", size: cache.size },
    jobs: { refreshTokenCleanup: "scheduled", topAnimeRefresh: "scheduled" },
    version: { api: "1.0.0", node: process.version },
    uptime: Math.floor(process.uptime()),
  }
  res.json(checks)
})

// OpenAPI spec
app.get("/api/v1/openapi.json", (_req, res) => res.json(spec));

// Sitemap
app.get("/sitemap.xml", async (_req, res) => {
  const anime = await prisma.anime.findMany({ select: { malId: true }, take: 500 });
  const urls = [
    "https://animeunwatched.com/",
    "https://animeunwatched.com/bestanimelist",
    "https://animeunwatched.com/ai-discover",
    "https://animeunwatched.com/community",
    "https://animeunwatched.com/leaderboard",
    ...anime.map((a: { malId: number }) => `https://animeunwatched.com/anime/${a.malId}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
  res.set("Content-Type", "application/xml").send(xml);
});

// API v1
app.use("/api/v1", router);

app.use(errorHandler);

export default app;
