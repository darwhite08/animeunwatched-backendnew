import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Public Trust Center. Aggregates everything customers want to verify
 * about us:
 *   - Live operational status (reuses /api/v1/status)
 *   - Compliance certifications, audit reports, principles
 *   - Sub-processor list (from VendorRecord)
 *   - Last KMS rotation overview (only the meta — no aliases or actual keys)
 *
 * No auth. Cacheable.
 */
export async function getTrustCenter(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [entries, vendors, kmsCount, lastKmsRotation] = await Promise.all([
      prisma.trustCenterEntry.findMany({ where: { active: true }, orderBy: [{ kind: "asc" }, { order: "asc" }] }),
      prisma.vendorRecord.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] }),
      prisma.kmsKeyRotation.count(),
      prisma.kmsKeyRotation.findFirst({ orderBy: { lastRotatedAt: "desc" }, select: { lastRotatedAt: true } }),
    ])

    const byKind: Record<string, typeof entries> = {}
    for (const e of entries) {
      byKind[e.kind] = byKind[e.kind] ?? []
      byKind[e.kind].push(e)
    }

    res.setHeader("Cache-Control", "public, max-age=300")  // 5-min CDN cache OK for the trust page
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      sections: {
        certifications: byKind["certification"] ?? [],
        principles:     byKind["principle"]     ?? [],
        documents:      byKind["document"]      ?? [],
        auditReports:   byKind["audit_report"]  ?? [],
        contacts:       byKind["contact"]       ?? [],
      },
      subProcessors: vendors.map(v => ({
        name: v.name, url: v.url, category: v.category,
        region: v.region, dataAccessed: v.dataAccessed, dpaUrl: v.dpaUrl,
      })),
      encryption: {
        algorithm: "AES-256-GCM (data) + TLS 1.3 (transit)",
        keysTracked: kmsCount,
        lastRotationAt: lastKmsRotation?.lastRotatedAt ?? null,
      },
      links: {
        status:    "/api/v1/status",
        changelog: "/api/v1/changelog",
      },
    })
  } catch (err) { next(err) }
}
