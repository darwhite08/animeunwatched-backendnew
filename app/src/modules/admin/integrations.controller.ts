import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

/**
 * Vendor integration registry. Each integration row references a Vault
 * secret name; the actual API key never round-trips through the admin API.
 * Vendor-specific behavior is in lib/integrations/<provider>.ts.
 */

interface ProviderMeta {
  provider:    string
  label:       string
  description: string
  configHints: Record<string, string>
}

export const PROVIDERS: ProviderMeta[] = [
  { provider: "datadog",        label: "Datadog",        description: "Forward EndpointStat metrics as Datadog series",            configHints: { region: '"us" | "eu"', metricPrefix: '"kaiveron"' } },
  { provider: "zendesk",        label: "Zendesk",        description: "Mirror new tickets into a Zendesk subdomain",               configHints: { subdomain: '"acme"', requesterEmail: '"support@acme.com"' } },
  { provider: "stripe_connect", label: "Stripe Connect", description: "Marketplace payout integration",                            configHints: { mode: '"test" | "live"' } },
  { provider: "slack",          label: "Slack",          description: "Generic Slack webhook destination (also via notify router)", configHints: { defaultChannel: '"#ops"' } },
  { provider: "linear",         label: "Linear",         description: "Auto-create Linear issues from sev1 incidents",             configHints: { teamId: '"TEAM_ABC"' } },
]

export async function listProviders(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json({ data: PROVIDERS }) } catch (err) { next(err) }
}

export async function listIntegrations(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.integration.findMany({ orderBy: [{ active: "desc" }, { provider: "asc" }] })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createIntegration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { provider, name, configJson, secretName, active } = req.body as Record<string, unknown>
    if (!PROVIDERS.some(p => p.provider === provider))         throw badRequest(`provider must be one of: ${PROVIDERS.map(p => p.provider).join(", ")}`)
    if (typeof name !== "string" || !name.trim())              throw badRequest("name required")
    const row = await prisma.integration.create({
      data: {
        provider: provider as string, name: name.trim(),
        configJson: (configJson ?? {}) as never,
        secretName: typeof secretName === "string" ? secretName : null,
        active:     active !== false,
        createdBy:  actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "integration.create", targetType: "Integration", targetId: row.id,
      metadata: { provider, name },
    })
    res.status(200).json({ integration: row })
  } catch (err) { next(err) }
}

export async function updateIntegration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.integration.findUnique({ where: { id } })
    if (!existing) throw notFound("Integration not found")
    const { name, configJson, secretName, active } = req.body as Record<string, unknown>
    const updated = await prisma.integration.update({
      where: { id },
      data: {
        ...(typeof name === "string" ? { name: name.trim() } : {}),
        ...(configJson !== undefined ? { configJson: configJson as never } : {}),
        ...(typeof secretName === "string" || secretName === null ? { secretName: secretName as string | null } : {}),
        ...(typeof active === "boolean" ? { active } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "integration.update", targetType: "Integration", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ integration: updated })
  } catch (err) { next(err) }
}

export async function deleteIntegration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.integration.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "integration.delete", targetType: "Integration", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

/** Run a sync for the named provider manually (test / on-demand). */
export async function syncProvider(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const provider = req.params.provider as string
    if (provider === "datadog") {
      const { pushDatadogMetrics } = await import("../../lib/integrations/datadog")
      const r = await pushDatadogMetrics()
      res.status(200).json(r)
      return
    }
    res.status(400).json({ error: { code: "BAD_REQUEST", message: `No sync implemented for ${provider}` } })
  } catch (err) { next(err) }
}
