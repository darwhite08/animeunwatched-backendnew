import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { isGA4Configured } from "../../lib/ga4";
import { probeMailer } from "../../lib/mailer";

/**
 * Snapshot of every external dependency the platform talks to. Used by
 * /admin/health to render an at-a-glance "all green / red" panel.
 *
 * Probes run in parallel; each one has a hard 3s timeout so the whole
 * report stays fast even when a dep is hanging.
 */
interface DepProbe {
  name:        string;
  status:      "ok" | "degraded" | "down" | "not_configured";
  latencyMs:   number | null;
  detail?:     string;
}

async function probe(name: string, fn: () => Promise<DepProbe>): Promise<DepProbe> {
  const start = Date.now();
  try {
    const timeout = new Promise<DepProbe>((_, rej) =>
      setTimeout(() => rej(new Error("probe timeout")), 3_000));
    const r = await Promise.race([fn(), timeout]);
    return { ...r, latencyMs: Date.now() - start };
  } catch (err) {
    return { name, status: "down", latencyMs: Date.now() - start, detail: (err as Error).message };
  }
}

async function probeDb(): Promise<DepProbe> {
  await prisma.$queryRaw`SELECT 1`;
  return { name: "PostgreSQL", status: "ok", latencyMs: 0 };
}

async function probeCache(): Promise<DepProbe> {
  const k = "__health_check__";
  cache.set(k, "ok", 1000);
  const v = cache.get(k);
  return { name: "In-process cache", status: v === "ok" ? "ok" : "degraded", latencyMs: 0,
    detail: `${cache.size} entries` };
}

async function probeJikan(): Promise<DepProbe> {
  const res = await fetch("https://api.jikan.moe/v4/genres/anime", { signal: AbortSignal.timeout(2_500) });
  return {
    name: "Jikan (anime catalog)",
    status: res.ok ? "ok" : res.status === 429 ? "degraded" : "down",
    latencyMs: 0,
    detail: `HTTP ${res.status}`,
  };
}

async function probeGa4(): Promise<DepProbe> {
  return {
    name: "Google Analytics 4 Data API",
    status: isGA4Configured() ? "ok" : "not_configured",
    latencyMs: 0,
    detail: isGA4Configured() ? "credentials present" : "GA_PROPERTY_ID / GA_SERVICE_ACCOUNT_JSON not set",
  };
}

async function probeS3(): Promise<DepProbe> {
  const bucket = process.env.S3_BUCKET ?? process.env.AWS_S3_BUCKET;
  return {
    name: "S3 storage",
    status: bucket ? "ok" : "not_configured",
    latencyMs: 0,
    detail: bucket ? `bucket: ${bucket}` : "S3_BUCKET env not set",
  };
}

async function probeMailerDep(): Promise<DepProbe> {
  const r = await probeMailer();
  return { name: "SMTP mailer", status: r.status, latencyMs: 0, detail: r.detail };
}

export async function getDependencies(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const results = await Promise.all([
      probe("PostgreSQL",   probeDb),
      probe("Cache",        probeCache),
      probe("Jikan",        probeJikan),
      probe("GA4",          probeGa4),
      probe("S3",           probeS3),
      probe("Mailer",       probeMailerDep),
    ]);
    const allOk = results.every(r => r.status === "ok" || r.status === "not_configured");
    res.status(200).json({ overallStatus: allOk ? "ok" : "degraded", dependencies: results, generatedAt: new Date().toISOString() });
  } catch (err) { next(err); }
}
