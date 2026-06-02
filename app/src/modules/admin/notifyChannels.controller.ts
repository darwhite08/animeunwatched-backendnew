import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { dispatchAdminEvent, type AdminSeverity } from "../../lib/notifyRouter"

const VALID_KIND = ["email", "slack", "webhook", "push"] as const
const VALID_SEV  = ["info", "warning", "critical"] as const

// ---- Channels ---------------------------------------------------------

export async function listChannels(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.notificationChannel.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, kind, configJson, active } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim()) throw badRequest("name required")
    if (!VALID_KIND.includes(kind as typeof VALID_KIND[number])) throw badRequest(`kind ∈ ${VALID_KIND.join("|")}`)
    if (!configJson || typeof configJson !== "object") throw badRequest("configJson required")
    const row = await prisma.notificationChannel.create({
      data: {
        name: name.trim(), kind: kind as string,
        configJson: configJson as never,
        active: active !== false,
        createdBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "notify.channel.create", targetType: "NotificationChannel", targetId: row.id,
      metadata: { name, kind },
    })
    res.status(200).json({ channel: row })
  } catch (err) { next(err) }
}

export async function updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.notificationChannel.findUnique({ where: { id } })
    if (!existing) throw notFound("Channel not found")
    const { name, configJson, active } = req.body as Record<string, unknown>
    const updated = await prisma.notificationChannel.update({
      where: { id },
      data: {
        ...(typeof name === "string" ? { name: name.trim() } : {}),
        ...(configJson !== undefined ? { configJson: configJson as never } : {}),
        ...(typeof active === "boolean" ? { active } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "notify.channel.update", targetType: "NotificationChannel", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ channel: updated })
  } catch (err) { next(err) }
}

export async function deleteChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.notificationChannel.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "notify.channel.delete", targetType: "NotificationChannel", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Rules -------------------------------------------------------------

export async function listRules(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.notificationRule.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { channels: { include: { channel: true } } },
    })
    res.status(200).json({ data: data.map(r => ({ ...r, channels: r.channels.map(c => c.channel) })) })
  } catch (err) { next(err) }
}

export async function createRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, eventPattern, minSeverity, channelIds, active } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim()) throw badRequest("name required")
    if (typeof eventPattern !== "string" || !eventPattern.trim()) throw badRequest("eventPattern required")
    if (minSeverity && !VALID_SEV.includes(minSeverity as typeof VALID_SEV[number])) throw badRequest(`minSeverity ∈ ${VALID_SEV.join("|")}`)
    const ids = Array.isArray(channelIds) ? channelIds.map(String) : []
    const row = await prisma.notificationRule.create({
      data: {
        name: name.trim(), eventPattern: eventPattern.trim(),
        minSeverity: typeof minSeverity === "string" ? minSeverity : "info",
        active: active !== false,
        createdBy: actorId,
        channels: { create: ids.map(channelId => ({ channelId })) },
      },
      include: { channels: { include: { channel: true } } },
    })
    await adminAuditR(req, res, {
      action: "notify.rule.create", targetType: "NotificationRule", targetId: row.id,
      metadata: { name, eventPattern, channelCount: ids.length },
    })
    res.status(200).json({ rule: { ...row, channels: row.channels.map(c => c.channel) } })
  } catch (err) { next(err) }
}

export async function updateRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.notificationRule.findUnique({ where: { id } })
    if (!existing) throw notFound("Rule not found")
    const { name, eventPattern, minSeverity, channelIds, active } = req.body as Record<string, unknown>
    if (minSeverity && !VALID_SEV.includes(minSeverity as typeof VALID_SEV[number])) throw badRequest(`minSeverity ∈ ${VALID_SEV.join("|")}`)
    const data: Record<string, unknown> = {}
    if (typeof name         === "string")  data.name = name.trim()
    if (typeof eventPattern === "string")  data.eventPattern = eventPattern.trim()
    if (typeof minSeverity  === "string")  data.minSeverity = minSeverity
    if (typeof active       === "boolean") data.active = active
    // Re-link channels if supplied
    await prisma.$transaction(async (tx) => {
      await tx.notificationRule.update({ where: { id }, data })
      if (Array.isArray(channelIds)) {
        await tx.notificationRuleChannel.deleteMany({ where: { ruleId: id } })
        await tx.notificationRuleChannel.createMany({
          data: channelIds.map(c => ({ ruleId: id, channelId: String(c) })),
        })
      }
    })
    await adminAuditR(req, res, {
      action: "notify.rule.update", targetType: "NotificationRule", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function deleteRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.notificationRule.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "notify.rule.delete", targetType: "NotificationRule", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Test dispatch ----------------------------------------------------

export async function testDispatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { event, severity, payload } = req.body as Record<string, unknown>
    if (typeof event !== "string") throw badRequest("event required")
    if (!VALID_SEV.includes(severity as typeof VALID_SEV[number])) throw badRequest(`severity ∈ ${VALID_SEV.join("|")}`)
    const r = await dispatchAdminEvent(event, severity as AdminSeverity, (payload as Record<string, unknown>) ?? { test: true })
    await adminAuditR(req, res, {
      action: "notify.test_dispatch", targetType: "NotificationRule",
      metadata: { event, severity, ...r },
    })
    res.status(200).json(r)
  } catch (err) { next(err) }
}
