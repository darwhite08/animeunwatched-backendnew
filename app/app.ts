import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./src/config/env";
import { errorHandler } from "./src/middlewares/error.middleware";
import router from "./src/routes";

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// API v1
app.use("/api/v1", router);

app.use(errorHandler);

export default app;
