import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Admin-side helpers for SCIM. The actual SCIM endpoints live at /scim/v2
 * and are gated by OAuth — these are read-only inspection helpers for the
 * admin UI to verify provisioning is flowing.
 */

export async function getScimStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const proto = (req.header("X-Forwarded-Proto") ?? "https").split(",")[0].trim()
    const host  = req.header("X-Forwarded-Host") ?? req.header("Host") ?? "api.kaiveron.com"
    const base  = `${proto}://${host}/scim/v2`

    const [subjectCount, recent, byIdp] = await Promise.all([
      prisma.scimSubject.count(),
      prisma.scimSubject.findMany({
        orderBy: { createdAt: "desc" }, take: 20,
        include: { user: { select: { id: true, username: true, email: true, isBanned: true } } },
      }),
      prisma.scimSubject.groupBy({ by: ["idpClientId"], _count: { _all: true } }),
    ])

    // Resolve idpClientId → client name
    const ids = byIdp.map(b => b.idpClientId).filter(Boolean) as string[]
    const clients = ids.length > 0
      ? await prisma.oauthClient.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : []
    const idpBreakdown = byIdp.map(b => ({
      clientId: b.idpClientId,
      name:     clients.find(c => c.id === b.idpClientId)?.name ?? "Unknown",
      count:    (b._count as { _all: number })._all,
    }))

    res.status(200).json({
      baseUrl:               base,
      discoveryUrl:          `${base}/ServiceProviderConfig`,
      usersUrl:              `${base}/Users`,
      requiredScope:         "scim",
      tokenEndpoint:         `${proto}://${host}/api/v1/oauth/token`,
      totalProvisionedUsers: subjectCount,
      idpBreakdown,
      recent: recent.map(r => ({
        externalId: r.externalId,
        createdAt:  r.createdAt,
        user:       r.user,
      })),
    })
  } catch (err) { next(err) }
}
