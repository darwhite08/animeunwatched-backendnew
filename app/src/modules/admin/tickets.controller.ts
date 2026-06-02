import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { fireTicketEvent } from "../../lib/ticketWebhooks"

const VALID_STATUS   = ["open", "in_progress", "resolved", "closed"] as const
const VALID_PRIORITY = ["low", "normal", "high", "urgent"] as const

export async function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status     = typeof req.query.status     === "string" ? req.query.status     : undefined
    const priority   = typeof req.query.priority   === "string" ? req.query.priority   : undefined
    const assigneeId = typeof req.query.assigneeId === "string" ? req.query.assigneeId : undefined
    const where: Record<string, unknown> = {}
    if (status)     where.status     = status
    if (priority)   where.priority   = priority
    if (assigneeId) where.assigneeId = assigneeId === "unassigned" ? null : assigneeId
    const data = await prisma.ticket.findMany({
      where, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 200,
      include: { _count: { select: { replies: true } } },
    })
    const counters: Record<string, number> = {}
    for (const t of data) counters[t.status] = (counters[t.status] ?? 0) + 1
    res.status(200).json({ data, counters })
  } catch (err) { next(err) }
}

export async function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const t = await prisma.ticket.findUnique({
      where: { id },
      include: { replies: { orderBy: { createdAt: "asc" } } },
    })
    if (!t) throw notFound("Ticket not found")
    res.status(200).json(t)
  } catch (err) { next(err) }
}

export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { subject, body, email, userId, priority, category } = req.body as Record<string, unknown>
    if (typeof subject !== "string" || !subject.trim()) throw badRequest("subject required")
    if (typeof body    !== "string" || !body.trim())    throw badRequest("body required")
    if (typeof email   !== "string" || !email.trim())   throw badRequest("email required")
    if (priority && !VALID_PRIORITY.includes(priority as typeof VALID_PRIORITY[number])) throw badRequest(`priority ∈ ${VALID_PRIORITY.join("|")}`)
    const t = await prisma.ticket.create({
      data: {
        subject: subject.trim(), body, email,
        userId:   typeof userId   === "string" ? userId   : null,
        priority: typeof priority === "string" ? priority : "normal",
        category: typeof category === "string" ? category : null,
      },
    })
    await adminAuditR(req, res, {
      action: "ticket.create", targetType: "Ticket", targetId: t.id,
      metadata: { subject: t.subject, email: t.email, openedBy: actorId },
    })
    void fireTicketEvent("ticket.created", { id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, email: t.email, userId: t.userId })
    res.status(200).json({ ticket: t })
  } catch (err) { next(err) }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const existing = await prisma.ticket.findUnique({ where: { id } })
    if (!existing) throw notFound("Ticket not found")
    const { status, priority, assigneeId, category, tags, subject } = req.body as Record<string, unknown>
    if (status   && !VALID_STATUS.includes(status     as typeof VALID_STATUS[number]))   throw badRequest(`status ∈ ${VALID_STATUS.join("|")}`)
    if (priority && !VALID_PRIORITY.includes(priority as typeof VALID_PRIORITY[number])) throw badRequest(`priority ∈ ${VALID_PRIORITY.join("|")}`)
    const data: Record<string, unknown> = {}
    if (typeof status     === "string") {
      data.status = status
      if (status === "resolved" && !existing.resolvedAt) data.resolvedAt = new Date()
      if (status === "closed"   && !existing.closedAt)   data.closedAt   = new Date()
    }
    if (typeof priority   === "string") data.priority = priority
    if (assigneeId        === null || typeof assigneeId === "string") data.assigneeId = assigneeId as string | null
    if (typeof category   === "string" || category === null) data.category = category as string | null
    if (Array.isArray(tags)) data.tags = tags.map(String)
    if (typeof subject    === "string") data.subject = subject.trim()
    const updated = await prisma.ticket.update({ where: { id }, data })
    await adminAuditR(req, res, {
      action: "ticket.update", targetType: "Ticket", targetId: id,
      metadata: { actorId, fields: Object.keys(req.body as object) },
    })
    if (typeof status === "string" && status !== existing.status) {
      void fireTicketEvent("ticket.status_changed", { id, number: updated.number, fromStatus: existing.status, toStatus: status })
    }
    res.status(200).json({ ticket: updated })
  } catch (err) { next(err) }
}

export async function addReply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const { body, isInternal } = req.body as Record<string, unknown>
    if (typeof body !== "string" || !body.trim()) throw badRequest("body required")
    const t = await prisma.ticket.findUnique({ where: { id } })
    if (!t) throw notFound("Ticket not found")
    const reply = await prisma.ticketReply.create({
      data: {
        ticketId: id, authorId: actorId, authorKind: "agent",
        body, isInternal: isInternal === true,
      },
    })
    // Move from "open" → "in_progress" on first agent reply
    if (t.status === "open") await prisma.ticket.update({ where: { id }, data: { status: "in_progress" } })
    await adminAuditR(req, res, {
      action: "ticket.reply", targetType: "Ticket", targetId: id,
      metadata: { isInternal: isInternal === true },
    })
    if (isInternal !== true) {
      void fireTicketEvent("ticket.replied", { id, number: t.number, replyId: reply.id, authorKind: "agent" })
    }
    res.status(200).json({ reply })
  } catch (err) { next(err) }
}
