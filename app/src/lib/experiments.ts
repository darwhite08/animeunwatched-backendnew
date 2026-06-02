import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * A/B variant assignment + exposure tracking.
 *
 * assignVariant(key, userId) returns a stable variant name based on
 * sha256(userId + ":" + key) mod 100, walked over the cumulative weight
 * ranges. The same (user, experiment-key) pair always returns the same
 * variant unless the experiment is paused/completed (in which case we
 * return the control or null).
 *
 * Call recordConversion(key, userId) after the primary metric fires.
 */

interface VariantRow { id: string; name: string; weight: number; isControl: boolean; payload: unknown }

function bucket(userId: string, key: string): number {
  const h = crypto.createHash("sha256").update(`${userId}:${key}`).digest()
  // Take first 4 bytes → uint32 → mod 100
  return h.readUInt32BE(0) % 100
}

export async function assignVariant(key: string, userId: string): Promise<{ variantName: string | null; payload: unknown }> {
  const exp = await prisma.experiment.findUnique({
    where: { key }, include: { variants: { orderBy: { name: "asc" } } },
  })
  if (!exp || exp.status !== "running" || exp.variants.length === 0) return { variantName: null, payload: null }

  const slot = bucket(userId, key)
  let cumulative = 0
  let chosen: VariantRow | null = null
  for (const v of exp.variants) {
    cumulative += v.weight
    if (slot < cumulative) { chosen = v; break }
  }
  if (!chosen) chosen = exp.variants.find(v => v.isControl) ?? exp.variants[0]

  // Record exposure async (idempotency: dedup is not enforced at the DB layer
  // — at most-once isn't critical; for analytics dedupe at read time)
  prisma.experimentExposure.create({
    data: { experimentId: exp.id, variantId: chosen.id, userId, event: "assigned" },
  }).catch(() => undefined)

  return { variantName: chosen.name, payload: chosen.payload }
}

export async function recordConversion(key: string, userId: string): Promise<void> {
  const exp = await prisma.experiment.findUnique({
    where: { key }, include: { variants: true },
  })
  if (!exp) return
  // Find this user's assigned variant by re-hashing — we don't need to read
  // the original exposure row.
  const slot = bucket(userId, key)
  let cumulative = 0
  let chosen: VariantRow | null = null
  for (const v of exp.variants) {
    cumulative += v.weight
    if (slot < cumulative) { chosen = v; break }
  }
  if (!chosen) return
  prisma.experimentExposure.create({
    data: { experimentId: exp.id, variantId: chosen.id, userId, event: "converted" },
  }).catch(() => undefined)
}

/** Results aggregation. Returns per-variant counts + lift vs control. */
export interface VariantResult {
  variantId:       string
  name:            string
  isControl:       boolean
  exposed:         number
  converted:       number
  conversionPct:   number
  liftPct:         number | null   // null for control
}

export async function getResults(key: string): Promise<{ variants: VariantResult[]; totalAssigned: number; totalConverted: number } | null> {
  const exp = await prisma.experiment.findUnique({
    where: { key },
    include: {
      variants:  { orderBy: { isControl: "desc" } },
      exposures: true,
    },
  })
  if (!exp) return null
  const byVariant: Record<string, { assigned: Set<string>; converted: Set<string> }> = {}
  for (const v of exp.variants) byVariant[v.id] = { assigned: new Set(), converted: new Set() }
  for (const e of exp.exposures) {
    if (!byVariant[e.variantId] || !e.userId) continue
    if (e.event === "assigned")  byVariant[e.variantId].assigned.add(e.userId)
    if (e.event === "converted") byVariant[e.variantId].converted.add(e.userId)
  }
  const control = exp.variants.find(v => v.isControl)
  const ctrlRate = control && byVariant[control.id].assigned.size > 0
    ? byVariant[control.id].converted.size / byVariant[control.id].assigned.size
    : 0

  const variants: VariantResult[] = exp.variants.map(v => {
    const exposed   = byVariant[v.id].assigned.size
    const converted = byVariant[v.id].converted.size
    const rate      = exposed > 0 ? converted / exposed : 0
    const lift      = v.isControl || ctrlRate === 0 ? null : ((rate - ctrlRate) / ctrlRate) * 100
    return {
      variantId: v.id, name: v.name, isControl: v.isControl,
      exposed, converted,
      conversionPct: +(rate * 100).toFixed(2),
      liftPct:       lift === null ? null : +lift.toFixed(2),
    }
  })

  return {
    variants,
    totalAssigned:  variants.reduce((s, v) => s + v.exposed, 0),
    totalConverted: variants.reduce((s, v) => s + v.converted, 0),
  }
}
