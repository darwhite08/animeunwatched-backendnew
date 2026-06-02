import crypto from "node:crypto";
import { prisma } from "../config/prisma";
import { adminAudit } from "../lib/adminAudit";

/**
 * Webhook dispatcher worker. Runs every 30 seconds.
 *
 * Selects WebhookDelivery rows that are due for attempt (succeededAt is null,
 * attempts < MAX_ATTEMPTS, last attempt was long enough ago for backoff),
 * fans them out to small concurrent batches, signs the payload with HMAC
 * SHA-256, and records the response.
 *
 * Backoff schedule (seconds since lastTriedAt):
 *   attempt 0 → immediate
 *   attempt 1 → 30
 *   attempt 2 → 300       (5 min)
 *   attempt 3 → 1800      (30 min)
 *   attempt 4 → 14400     (4 hr)
 * After MAX_ATTEMPTS the row is considered permanently failed (operator can
 * still replay manually from /webhooks).
 */

const MAX_ATTEMPTS = 5;
const CONCURRENCY  = 4;
const TICK_MS      = 30_000;
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

const BACKOFF_SEC = [0, 30, 300, 1800, 14_400] as const;

function dueAt(lastTriedAt: Date | null, attempts: number): number {
  if (attempts === 0) return 0;
  if (!lastTriedAt) return 0;
  const idx = Math.min(attempts, BACKOFF_SEC.length - 1);
  return lastTriedAt.getTime() + BACKOFF_SEC[idx] * 1000;
}

function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${timestamp}.${body}`);
  return `t=${timestamp},v1=${mac.digest("hex")}`;
}

async function attemptDelivery(delivery: {
  id: string; endpointId: string; eventName: string; eventId: string;
  payload: unknown; attempts: number;
  endpoint: { url: string; secret: string; enabled: boolean };
}): Promise<void> {
  if (!delivery.endpoint.enabled) {
    // Endpoint disabled: skip silently, don't burn attempts.
    return;
  }
  const body = JSON.stringify(delivery.payload);
  const ts   = Math.floor(Date.now() / 1000);
  const signature = signPayload(delivery.endpoint.secret, body, ts);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);

  let responseStatus: number | null = null;
  let responseBody:   string | null = null;
  try {
    const res = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "X-Kaiveron-Signature": signature,
        "X-Kaiveron-Event":     delivery.eventName,
        "X-Kaiveron-Event-Id":  delivery.eventId,
        "X-Kaiveron-Attempt":   String(delivery.attempts + 1),
      },
      body,
      signal: controller.signal,
    });
    responseStatus = res.status;
    responseBody = (await res.text().catch(() => "")).slice(0, 1000);

    if (res.status >= 200 && res.status < 300) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts:       delivery.attempts + 1,
          succeededAt:    new Date(),
          lastTriedAt:    new Date(),
          responseStatus,
          responseBody,
        },
      });
      return;
    }
  } catch (err) {
    responseBody = (err as Error).message.slice(0, 500);
  } finally {
    clearTimeout(timeout);
  }

  const nextAttempts = delivery.attempts + 1;
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts:       nextAttempts,
      lastTriedAt:    new Date(),
      responseStatus,
      responseBody,
    },
  });

  if (nextAttempts >= MAX_ATTEMPTS) {
    await adminAudit({
      actorId: null,
      action:  "webhook.delivery_failed",
      targetType: "WebhookDelivery",
      targetId:   delivery.id,
      metadata: {
        endpointId: delivery.endpointId, eventName: delivery.eventName,
        eventId:    delivery.eventId, attempts: nextAttempts, responseStatus,
      },
    });
  }
}

async function tick(): Promise<void> {
  // Fetch a small batch of due deliveries.
  const candidates = await prisma.webhookDelivery.findMany({
    where: {
      succeededAt: null,
      attempts:    { lt: MAX_ATTEMPTS },
    },
    include: {
      endpoint: { select: { url: true, secret: true, enabled: true } },
    },
    orderBy: [{ lastTriedAt: "asc" }, { createdAt: "asc" }],
    take:    50,
  });

  const dueNow = candidates.filter(c =>
    dueAt(c.lastTriedAt as Date | null, c.attempts) <= Date.now());

  if (dueNow.length === 0) return;

  // Process in small concurrent batches
  for (let i = 0; i < dueNow.length; i += CONCURRENCY) {
    const batch = dueNow.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(d => attemptDelivery(d).catch(err =>
      console.error("[webhook-dispatcher] delivery", d.id, "failed:", err))));
  }
}

let running = false;

export function startWebhookDispatcher(): void {
  // Skip in tests
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch(err => console.error("[webhook-dispatcher] tick failed:", err))
      .finally(() => { running = false });
  }, TICK_MS).unref();
  console.log("[webhook-dispatcher] started — interval", TICK_MS, "ms");
}

/**
 * Enqueue a webhook delivery for every endpoint subscribed to this event.
 * Call from anywhere in the app when a notable event happens.
 */
export async function enqueueWebhook(eventName: string, payload: Record<string, unknown>): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true },
  });
  const eventId = crypto.randomUUID();
  for (const ep of endpoints) {
    const events = Array.isArray(ep.events) ? ep.events as unknown[] : [];
    if (!events.includes(eventName)) continue;
    await prisma.webhookDelivery.create({
      data: {
        endpointId: ep.id,
        eventName, eventId,
        payload:    payload as never,
        attempts:   0,
      },
    });
  }
}
