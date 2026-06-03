import { prisma } from "../../config/prisma"
import { readSecret } from "../vault"

/**
 * Zendesk one-way mirror: when a Kaiveron ticket is created or replied to,
 * push a matching ticket / comment into the configured Zendesk subdomain.
 *
 * Reads credentials from the Vault (API key) so we never store the token
 * in env or DB plaintext. Config shape (Integration.configJson):
 *   {
 *     subdomain:      "acme",                // becomes https://acme.zendesk.com
 *     requesterEmail: "support@acme.com",    // sender-of-record for created tickets
 *     userEmail:      "agent@acme.com",      // optional Zendesk agent identity (defaults to requesterEmail)
 *   }
 *
 * Vault secret format: "<agentEmail>:<api_token>" — Zendesk requires HTTP
 * Basic with `<email>/token:<api_token>` so we pack both into one secret.
 *
 * The mirror is one-way for now (Kaiveron → Zendesk). Bidirectional sync
 * (Zendesk replies → Kaiveron ticket) would need a Zendesk webhook + our
 * /api/v1/integrations/zendesk/webhook handler — left for a follow-up.
 *
 * Called by the existing fireTicketEvent() side-effect on ticket.created
 * and ticket.replied (wired in lib/ticketWebhooks.ts where we add the
 * Zendesk shortcut). All API errors flow through the standard
 * Integration.lastSyncStatus tracking so the admin UI lights up red on
 * failure.
 */

interface ZendeskConfig {
  subdomain?:      string
  requesterEmail?: string
  userEmail?:      string
}

interface ZendeskCreds { email: string; token: string }

async function getConfig(): Promise<{ config: ZendeskConfig; creds: ZendeskCreds; integrationId: string } | null> {
  const integration = await prisma.integration.findFirst({ where: { provider: "zendesk", active: true } })
  if (!integration) return null
  const cfg = (integration.configJson ?? {}) as ZendeskConfig
  if (!cfg.subdomain) {
    await markFail(integration.id, "configJson.subdomain required")
    return null
  }
  const raw = integration.secretName ? await readSecret(integration.secretName) : null
  if (!raw) {
    await markFail(integration.id, `vault secret "${integration.secretName ?? "(unset)"}" not found`)
    return null
  }
  const idx = raw.indexOf(":")
  if (idx < 1) {
    await markFail(integration.id, `vault secret must be "<email>:<api_token>"`)
    return null
  }
  return {
    integrationId: integration.id,
    config: cfg,
    creds:  { email: raw.slice(0, idx), token: raw.slice(idx + 1) },
  }
}

function basicAuth(creds: ZendeskCreds): string {
  const auth = Buffer.from(`${creds.email}/token:${creds.token}`).toString("base64")
  return `Basic ${auth}`
}

/** Push a new Kaiveron ticket to Zendesk; returns the Zendesk ticket id (or null on failure). */
export async function mirrorTicketCreated(opts: {
  number:  number
  subject: string
  body:    string
  requesterEmail: string                   // the end-user's email (becomes Zendesk requester)
}): Promise<{ zendeskId: number } | null> {
  const ctx = await getConfig()
  if (!ctx) return null
  try {
    const r = await fetch(`https://${ctx.config.subdomain}.zendesk.com/api/v2/tickets.json`, {
      method:  "POST",
      headers: { Authorization: basicAuth(ctx.creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: {
          subject: `[Kaiveron #${opts.number}] ${opts.subject}`,
          comment: { body: opts.body },
          requester: { name: opts.requesterEmail, email: opts.requesterEmail },
          external_id: `kaiveron:${opts.number}`,
          tags: ["kaiveron-mirror"],
        },
      }),
    })
    if (!r.ok) throw new Error(`Zendesk returned ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
    const json = await r.json() as { ticket?: { id?: number } }
    await markOk(ctx.integrationId)
    return json.ticket?.id ? { zendeskId: json.ticket.id } : null
  } catch (err) {
    await markFail(ctx.integrationId, (err as Error).message)
    return null
  }
}

/** Append a reply to the mirrored Zendesk ticket — uses external_id lookup. */
export async function mirrorTicketReplied(opts: { number: number; body: string }): Promise<void> {
  const ctx = await getConfig()
  if (!ctx) return
  try {
    // Find the Zendesk ticket by external_id, then PUT a comment.
    const search = await fetch(`https://${ctx.config.subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(`type:ticket external_id:kaiveron:${opts.number}`)}`, {
      headers: { Authorization: basicAuth(ctx.creds) },
    })
    if (!search.ok) throw new Error(`Zendesk search returned ${search.status}`)
    const sj = await search.json() as { results?: Array<{ id: number }> }
    const zid = sj.results?.[0]?.id
    if (!zid) {
      await markFail(ctx.integrationId, `no mirrored ticket for kaiveron:${opts.number}`)
      return
    }
    const r = await fetch(`https://${ctx.config.subdomain}.zendesk.com/api/v2/tickets/${zid}.json`, {
      method:  "PUT",
      headers: { Authorization: basicAuth(ctx.creds), "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: { comment: { body: opts.body, public: true } } }),
    })
    if (!r.ok) throw new Error(`Zendesk comment returned ${r.status}`)
    await markOk(ctx.integrationId)
  } catch (err) {
    await markFail(ctx.integrationId, (err as Error).message)
  }
}

async function markOk(id: string): Promise<void> {
  await prisma.integration.update({
    where: { id }, data: { lastSyncAt: new Date(), lastSyncStatus: "ok", lastError: null },
  }).catch(() => undefined)
}
async function markFail(id: string, detail: string): Promise<void> {
  await prisma.integration.update({
    where: { id }, data: { lastSyncAt: new Date(), lastSyncStatus: "fail", lastError: detail.slice(0, 500) },
  }).catch(() => undefined)
}
