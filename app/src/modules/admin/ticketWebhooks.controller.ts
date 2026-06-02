import type { Request, Response, NextFunction } from "express"
import crypto from "node:crypto"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const VALID_EVENTS = ["*", "ticket.created", "ticket.replied", "ticket.status_changed"] as const

export async function listHooks(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.ticketWebhook.findMany({ orderBy: { createdAt: "desc" } })
    // Never echo the secret
    const sanitized = rows.map(({ secret, ...rest }) => rest)
    res.status(200).json({ data: sanitized })
  } catch (err) { next(err) }
}

export async function createHook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { url, events, description, active } = req.body as Record<string, unknown>
    if (typeof url !== "string" || !url.trim()) throw badRequest("url required")
    const ev = Array.isArray(events) ? events.map(String) : ["*"]
    for (const e of ev) if (!VALID_EVENTS.includes(e as typeof VALID_EVENTS[number])) throw badRequest(`event ∈ ${VALID_EVENTS.join("|")}`)
    const secret = crypto.randomBytes(32).toString("hex")
    const row = await prisma.ticketWebhook.create({
      data: {
        url: url.trim(), events: ev, secret,
        description: typeof description === "string" ? description : null,
        active:      active !== false,
        createdBy:   actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "ticket_webhook.create", targetType: "TicketWebhook", targetId: row.id,
      metadata: { url, events: ev },
    })
    const { secret: _drop, ...rest } = row
    res.status(200).json({ hook: rest, secret, _warning: "Store this secret — required to verify HMAC signature. Will not be shown again." })
  } catch (err) { next(err) }
}

export async function updateHook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.ticketWebhook.findUnique({ where: { id } })
    if (!existing) throw notFound("Webhook not found")
    const { url, events, description, active } = req.body as Record<string, unknown>
    if (Array.isArray(events)) for (const e of events.map(String)) if (!VALID_EVENTS.includes(e as typeof VALID_EVENTS[number])) throw badRequest(`event ∈ ${VALID_EVENTS.join("|")}`)
    const updated = await prisma.ticketWebhook.update({
      where: { id },
      data: {
        ...(typeof url         === "string"  ? { url } : {}),
        ...(Array.isArray(events) ? { events: events.map(String) } : {}),
        ...(typeof description === "string"  || description === null ? { description: description as string | null } : {}),
        ...(typeof active      === "boolean" ? { active } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "ticket_webhook.update", targetType: "TicketWebhook", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    const { secret, ...rest } = updated
    res.status(200).json({ hook: rest })
  } catch (err) { next(err) }
}

export async function rotateHookSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.ticketWebhook.findUnique({ where: { id } })
    if (!existing) throw notFound("Webhook not found")
    const secret = crypto.randomBytes(32).toString("hex")
    await prisma.ticketWebhook.update({ where: { id }, data: { secret } })
    await adminAuditR(req, res, { action: "ticket_webhook.rotate", targetType: "TicketWebhook", targetId: id })
    res.status(200).json({ secret, _warning: "Old secret invalidated. Update your consumer." })
  } catch (err) { next(err) }
}

export async function deleteHook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.ticketWebhook.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "ticket_webhook.delete", targetType: "TicketWebhook", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
