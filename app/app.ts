import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./src/config/env";
import { errorHandler } from "./src/middlewares/error.middleware";
import { rateLimit } from "./src/middlewares/rateLimit.middleware";
import router from "./src/routes";
import { spec } from "./src/openapi";
import { prisma } from "./src/config/prisma";

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Global rate limit: 100 req/min per IP
app.use(rateLimit(100, 60_000));

// Stricter rate limit on auth routes: 20 req per 15 min per IP
app.use("/api/v1/auth", rateLimit(20, 15 * 60_000));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

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
