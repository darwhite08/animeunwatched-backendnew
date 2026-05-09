import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./src/config/env";
import { errorHandler } from "./src/middlewares/error.middleware";
import { rateLimit } from "./src/middlewares/rateLimit.middleware";
import router from "./src/routes";

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

// API v1
app.use("/api/v1", router);

app.use(errorHandler);

export default app;
