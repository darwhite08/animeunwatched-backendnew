import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { invalidateContentRuleCache, matchContent } from "../../lib/contentMatcher"

/**
 * M7+ — content auto-flag rules. Operators define keyword/regex/length
 * /link-count rules; the runtime matcher (lib/contentMatcher) consults
 * them on every post/comment/blog/review and either flags (queue),
 * shadow-bans the content, or refuses outright.
 */

const KINDS     = ["keyword", "regex", "min_length", "link_count"] as const
const TARGETS   = ["post", "comment", "blog", "review"] as const
const SEVERITY  = ["flag", "shadow", "block"] as const

export async function listRules(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.contentRule.findMany({ orderBy: [{ enabled: "desc" }, { createdAt: "desc" }] })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, kind, pattern, target, severity, enabled } = req.body as Record<string, unknown>
    if (typeof name !== "string" || typeof kind !== "string" || typeof pattern !== "string") {
      throw badRequest("name, kind, pattern required")
    }
    if (!KINDS.includes(kind as typeof KINDS[number]))         throw badRequest(`kind ∈ ${KINDS.join("|")}`)
    if (target && !TARGETS.includes(target as typeof TARGETS[number])) throw badRequest(`target ∈ ${TARGETS.join("|")}`)
    if (severity && !SEVERITY.includes(severity as typeof SEVERITY[number])) throw badRequest(`severity ∈ ${SEVERITY.join("|")}`)
    if (kind === "regex") {
      try { new RegExp(pattern, "i") } catch (e) { throw badRequest(`invalid regex: ${(e as Error).message}`) }
    }
    const rule = await prisma.contentRule.create({
      data: {
        name, kind, pattern,
        target:   (target as string) ?? "post",
        severity: (severity as string) ?? "flag",
        enabled:  enabled !== false,
        createdBy: actorId,
      },
    })
    invalidateContentRuleCache()
    await adminAuditR(req, res, {
      action: "content_rule.create", targetType: "ContentRule", targetId: rule.id,
      metadata: { name, kind, target: rule.target, severity: rule.severity },
    })
    res.status(200).json({ rule })
  } catch (err) { next(err) }
}

export async function updateRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const rule = await prisma.contentRule.findUnique({ where: { id } })
    if (!rule) throw notFound("Rule not found")
    const { name, pattern, target, severity, enabled } = req.body as Record<string, unknown>
    const updated = await prisma.contentRule.update({
      where: { id },
      data: {
        ...(typeof name     === "string"  ? { name }     : {}),
        ...(typeof pattern  === "string"  ? { pattern }  : {}),
        ...(typeof target   === "string" && TARGETS.includes(target as typeof TARGETS[number])   ? { target }   : {}),
        ...(typeof severity === "string" && SEVERITY.includes(severity as typeof SEVERITY[number]) ? { severity } : {}),
        ...(typeof enabled  === "boolean" ? { enabled }  : {}),
      },
    })
    invalidateContentRuleCache()
    await adminAuditR(req, res, {
      action: "content_rule.update", targetType: "ContentRule", targetId: id,
      metadata: { name, target, severity, enabled },
    })
    res.status(200).json({ rule: updated })
  } catch (err) { next(err) }
}

export async function deleteRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.contentRule.delete({ where: { id } }).catch(() => undefined)
    invalidateContentRuleCache()
    await adminAuditR(req, res, {
      action: "content_rule.delete", targetType: "ContentRule", targetId: id,
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

/** Dry-run: feed a string through the matcher and return the strongest match. */
export async function testRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { content, target } = req.body as { content?: string; target?: "post"|"comment"|"blog"|"review" }
    if (!content) throw badRequest("content required")
    const match = await matchContent({ content, target: target ?? "post" })
    res.status(200).json({ match })
  } catch (err) { next(err) }
}
