type WebhookEvent = "user.registered" | "streak.milestone" | "achievement.unlocked" | "reputation.threshold"

type WebhookPayload = { event: WebhookEvent; userId: string; data: Record<string, unknown>; ts: string }

const WEBHOOK_URLS: string[] = [] // populated from env in future

export async function fireWebhook(event: WebhookEvent, userId: string, data: Record<string, unknown>): Promise<void> {
  const payload: WebhookPayload = { event, userId, data, ts: new Date().toISOString() }
  console.log(`[Webhook] ${event}`, JSON.stringify(payload))
  // In production: POST to each URL in WEBHOOK_URLS
  // For now just log
  void WEBHOOK_URLS
}

export function buildTestPayload(event: WebhookEvent, userId: string, data: Record<string, unknown>): WebhookPayload {
  return { event, userId, data, ts: new Date().toISOString() }
}
