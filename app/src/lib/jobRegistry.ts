/**
 * Lightweight in-process job registry. The repo doesn't run BullMQ/Sidekiq —
 * background work is plain `setInterval` calls in src/jobs/. This module
 * tracks each registered tick so /admin/jobs can show last-run time, last
 * status, and let operators trigger a manual retry.
 */

export interface JobRecord {
  name:          string;
  description:   string;
  intervalMs:    number;
  lastRunAt:     Date | null;
  lastDurationMs: number | null;
  lastStatus:    "idle" | "running" | "ok" | "error";
  lastError:     string | null;
  runCount:      number;
}

const registry = new Map<string, JobRecord>();
const handlers = new Map<string, () => Promise<unknown> | unknown>();

export function registerJob(opts: {
  name: string; description: string; intervalMs: number;
  handler: () => Promise<unknown> | unknown;
}): void {
  registry.set(opts.name, {
    name: opts.name, description: opts.description, intervalMs: opts.intervalMs,
    lastRunAt: null, lastDurationMs: null,
    lastStatus: "idle", lastError: null, runCount: 0,
  });
  handlers.set(opts.name, opts.handler);
}

export async function runJob(name: string): Promise<void> {
  const rec = registry.get(name);
  const handler = handlers.get(name);
  if (!rec || !handler) throw new Error(`unknown job: ${name}`);
  rec.lastStatus = "running";
  const start = Date.now();
  try {
    await handler();
    rec.lastStatus = "ok";
    rec.lastError = null;
  } catch (err) {
    rec.lastStatus = "error";
    rec.lastError = (err as Error).message;
    throw err;
  } finally {
    rec.lastRunAt = new Date();
    rec.lastDurationMs = Date.now() - start;
    rec.runCount++;
  }
}

export function listJobs(): JobRecord[] {
  return Array.from(registry.values());
}

/**
 * Wrap a handler so each invocation auto-updates the registry. Use this
 * instead of calling setInterval directly so /admin/jobs sees activity.
 */
export function instrument(name: string, fn: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    const rec = registry.get(name);
    if (!rec) { await fn(); return }
    const start = Date.now();
    rec.lastStatus = "running";
    try {
      await fn();
      rec.lastStatus = "ok"; rec.lastError = null;
    } catch (err) {
      rec.lastStatus = "error"; rec.lastError = (err as Error).message;
      console.error(`[job ${name}] failed:`, err);
    } finally {
      rec.lastRunAt = new Date();
      rec.lastDurationMs = Date.now() - start;
      rec.runCount++;
    }
  };
}
