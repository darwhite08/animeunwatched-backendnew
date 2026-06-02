import crypto from "node:crypto"
import { prisma } from "../config/prisma"

/**
 * Auto-flag content moderator. Returns the strongest matching rule
 * (block > shadow > flag), null if nothing matches.
 *
 * Cached for 30 s so the matcher doesn't hammer the rules table on
 * every post. Invalidated on rule mutations from the admin UI.
 */
export interface ContentMatch {
  ruleId:   string
  ruleName: string
  severity: "flag" | "shadow" | "block"
  detail:   string
}

interface CachedRule {
  id: string; name: string; kind: string; pattern: string; severity: string
}

let cache: { rules: CachedRule[]; expiresAt: number } | null = null
const TTL_MS = 30_000

export function invalidateContentRuleCache(): void { cache = null }

async function loadRules(target: string): Promise<CachedRule[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.rules.filter(r => r.kind !== "min_length" || true)
  const rows = await prisma.contentRule.findMany({
    where: { enabled: true, target },
    select: { id: true, name: true, kind: true, pattern: true, severity: true },
  })
  cache = { rules: rows, expiresAt: Date.now() + TTL_MS }
  return rows
}

const SEVERITY_RANK = { flag: 1, shadow: 2, block: 3 } as const

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

export function contentHash(s: string): string {
  return crypto.createHash("sha256").update(normalize(s)).digest("hex")
}

export async function matchContent(opts: {
  content: string
  target:  "post" | "comment" | "blog" | "review"
}): Promise<ContentMatch | null> {
  if (!opts.content) return null
  const rules = await loadRules(opts.target)
  const matches: ContentMatch[] = []
  const text   = opts.content
  const lower  = text.toLowerCase()

  for (const r of rules) {
    try {
      if (r.kind === "keyword") {
        // Case-insensitive substring match. Pattern can be comma-separated.
        const needles = r.pattern.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
        const hit = needles.find(n => lower.includes(n))
        if (hit) matches.push({ ruleId: r.id, ruleName: r.name, severity: r.severity as ContentMatch["severity"], detail: `keyword "${hit}"` })
      } else if (r.kind === "regex") {
        const re = new RegExp(r.pattern, "i")
        if (re.test(text)) matches.push({ ruleId: r.id, ruleName: r.name, severity: r.severity as ContentMatch["severity"], detail: `regex /${r.pattern}/` })
      } else if (r.kind === "min_length") {
        const min = parseInt(r.pattern, 10)
        if (!isNaN(min) && text.length < min) matches.push({ ruleId: r.id, ruleName: r.name, severity: r.severity as ContentMatch["severity"], detail: `length ${text.length} < ${min}` })
      } else if (r.kind === "link_count") {
        const max   = parseInt(r.pattern, 10)
        const count = (text.match(/https?:\/\//g) ?? []).length
        if (!isNaN(max) && count > max) matches.push({ ruleId: r.id, ruleName: r.name, severity: r.severity as ContentMatch["severity"], detail: `${count} links > ${max}` })
      }
    } catch { /* skip bad rules */ }
  }

  if (matches.length === 0) return null
  matches.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const winner = matches[0]

  // Mark the rule as used.
  void prisma.contentRule.update({
    where: { id: winner.ruleId },
    data:  { matchCount: { increment: 1 }, lastMatchAt: new Date() },
  }).catch(() => undefined)

  return winner
}

/** Fingerprint a piece of content for the admin "duplicate content" lookup. */
export async function recordFingerprint(opts: {
  content:    string
  targetType: string
  targetId:   string
  decision:   "flag" | "removed" | "approved"
  matchedRule?: string
}): Promise<void> {
  const hash = contentHash(opts.content)
  await prisma.contentFingerprint.upsert({
    where:  { hash },
    update: { decision: opts.decision, matchedRule: opts.matchedRule ?? null },
    create: { hash, targetType: opts.targetType, targetId: opts.targetId, decision: opts.decision, matchedRule: opts.matchedRule ?? null },
  })
}
