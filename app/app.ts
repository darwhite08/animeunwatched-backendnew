// Sentry must be initialized before anything else
import * as Sentry from "@sentry/node";
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    enabled: process.env.NODE_ENV === "production",
  });
}

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./src/config/env";
import { errorHandler } from "./src/middlewares/error.middleware";
import { rateLimit } from "./src/middlewares/rateLimit.middleware";
import { requestId } from "./src/middlewares/requestId.middleware";
import { logger } from "./src/lib/logger";
import { responseTime, requestLogger } from "./src/middlewares/performance.middleware";
import { apiVersionHeader } from "./src/middlewares/apiVersion.middleware";
import { slaMetrics } from "./src/middlewares/slaMetrics.middleware";
import router from "./src/routes";
import { currentMaintenance } from "./src/modules/admin/maintenance.controller";
import { spec } from "./src/openapi";
import { prisma } from "./src/config/prisma";
import { cache } from "./src/lib/cache";

const app = express();

// Trust Render/cloud reverse proxy so req.protocol reflects https correctly
app.set("trust proxy", 1);

// Per-request correlation id + structured JSON logger. requestId must run
// before pino-http so the log line carries the id we set on res.locals.
app.use(requestId);
app.use(
  pinoHttp({
    logger,
    // Pull the id we just set so log lines + response header stay in sync
    genReqId: (_req, res) => (res as any).locals?.requestId ?? "",
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400)        return "warn";
      return "info";
    },
    // Quiet success-path noise; keep failures verbose
    customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
    customErrorMessage:   (req, res, err) =>
      `${req.method} ${req.url} → ${res.statusCode} ${err.message ?? ""}`.trim(),
    // Don't log static assets or health-check polling — they drown signal
    autoLogging: {
      ignore: (req) =>
        req.url === "/health" ||
        req.url === "/api/v1/version" ||
        req.url?.startsWith("/favicon.ico") || false,
    },
  }),
);

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

// Accept any kaiveron.com subdomain — main site, www, admin-dashboard, etc.
// Single source of truth so adding a new subdomain doesn't require an env change.
function isKaiveronOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname === "kaiveron.com" || hostname.endsWith(".kaiveron.com")
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

// Security headers — must come first.
// Hardened: explicit HSTS (2-year preload), stricter Cross-Origin policies,
// X-DNS-Prefetch-Control off, no referrer leakage, no client-side caching of API
// responses to avoid stale-auth state on shared devices.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // CSP is set by Next.js for the frontend — the API doesn't serve HTML
  contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
  hsts: {
    maxAge:           63072000,  // 2 years (HSTS preload list requirement)
    includeSubDomains: true,
    preload:          true,
  },
  referrerPolicy:           { policy: "no-referrer" },
  noSniff:                  true,
  xssFilter:                true,
  dnsPrefetchControl:       { allow: false },
  frameguard:               { action: "deny" },
  permittedCrossDomainPolicies: { permittedPolicies: "none" },
}));

// API responses should never be cached by the client/proxy — every response
// can contain auth state that's invalid for another user
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private")
  res.setHeader("Pragma", "no-cache")
  next()
});

// Sentry request handler — must come before other middleware
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use(responseTime);
app.use(requestLogger);
// Per-endpoint RED metrics (record on response finish, never blocks the request)
app.use(slaMetrics());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (origin && (isLocalNetworkOrigin(origin) || isVercelPreviewOrigin(origin) || isKaiveronOrigin(origin)))) {
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

// Public status — frontends fetch current maintenance window for the banner
app.get("/api/v1/status/maintenance", currentMaintenance);

// API v1
app.use("/api/v1", router);

app.use(errorHandler);

export default app;
