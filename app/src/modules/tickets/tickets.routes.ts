import { Router } from "express"
import { prisma } from "../../config/prisma"
import { badRequest } from "../../lib/errors"
import { optionalAuth } from "../../middlewares/auth.middleware"

export const ticketsRouter = Router()

/**
 * POST /api/v1/tickets — public-ish ticket creation. Anyone can open
 * a ticket; if they're authenticated, we link it to their userId. Rate-
 * limited by the global limiter to prevent abuse.
 */
ticketsRouter.post("/", optionalAuth, async (req, res, next) => {
  try {
    const userId = (res.locals.user as { id?: string } | undefined)?.id
    const { subject, body, email, category } = req.body as Record<string, unknown>
    if (typeof subject !== "string" || !subject.trim() || subject.length > 200) throw badRequest("subject required (≤ 200 chars)")
    if (typeof body    !== "string" || !body.trim()    || body.length    > 8000) throw badRequest("body required (≤ 8000 chars)")
    if (typeof email   !== "string" || !email.trim())                            throw badRequest("email required")

    const t = await prisma.ticket.create({
      data: {
        subject: subject.trim(), body, email,
        userId: userId ?? null,
        category: typeof category === "string" ? category : null,
      },
    })
    res.status(200).json({ ticket: { id: t.id, number: t.number, status: t.status } })
  } catch (err) { next(err) }
})
