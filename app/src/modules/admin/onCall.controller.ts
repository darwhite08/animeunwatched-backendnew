import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { generateRotation, getCurrentOnCall } from "../../lib/onCall"

const VALID_SEV = ["critical", "warning", "info"] as const

// ---- Schedules + shifts ------------------------------------------------

export async function listSchedules(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const schedules = await prisma.onCallSchedule.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        shifts: {
          where: { endsAt: { gte: new Date(Date.now() - 24*60*60_000) } },
          orderBy: { startsAt: "asc" }, take: 20,
        },
      },
    })
    // Resolve user identities for shifts
    const userIds = Array.from(new Set(schedules.flatMap(s => s.shifts.map(sh => sh.userId))))
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const userMap = new Map(users.map(u => [u.id, u]))
    const data = schedules.map(s => ({
      ...s,
      currentOnCall: (() => {
        const now = new Date()
        const cur = s.shifts.find(sh => sh.startsAt <= now && sh.endsAt > now)
        if (!cur) return null
        return { shiftId: cur.id, user: userMap.get(cur.userId) ?? { id: cur.userId, username: "?", displayName: "?" } }
      })(),
      shifts: s.shifts.map(sh => ({ ...sh, user: userMap.get(sh.userId) ?? null })),
    }))
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, timezone, rotationDays } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim()) throw badRequest("name required")
    const row = await prisma.onCallSchedule.create({
      data: {
        name: name.trim(),
        timezone:     typeof timezone === "string" ? timezone : "UTC",
        rotationDays: Number(rotationDays) || 7,
      },
    })
    await adminAuditR(req, res, {
      action: "oncall.schedule.create", targetType: "OnCallSchedule", targetId: row.id,
      metadata: { name, createdBy: actorId },
    })
    res.status(200).json({ schedule: row })
  } catch (err) { next(err) }
}

export async function postRotation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const scheduleId = req.params.id as string
    const { userIds, startsAt, cycles } = req.body as Record<string, unknown>
    if (!Array.isArray(userIds) || userIds.length === 0) throw badRequest("userIds[] required")
    if (typeof startsAt !== "string") throw badRequest("startsAt required (ISO)")
    const n = Number(cycles)
    if (!Number.isFinite(n) || n < 1 || n > 26) throw badRequest("cycles must be 1..26")
    const count = await generateRotation({
      scheduleId, userIds: userIds.map(String),
      startsAt: new Date(startsAt), cycles: Math.round(n),
    })
    await adminAuditR(req, res, {
      action: "oncall.rotation.generate", targetType: "OnCallSchedule", targetId: scheduleId,
      metadata: { count, users: userIds.length, actorId },
    })
    res.status(200).json({ shiftsCreated: count })
  } catch (err) { next(err) }
}

export async function getCurrent(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cur = await getCurrentOnCall()
    if (!cur) { res.status(200).json({ onCall: null }); return }
    const user = await prisma.user.findUnique({
      where: { id: cur.userId },
      select: { id: true, username: true, displayName: true, email: true },
    })
    res.status(200).json({ onCall: { ...cur, user } })
  } catch (err) { next(err) }
}

export async function deleteShift(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.onCallShift.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "oncall.shift.delete", targetType: "OnCallShift", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Escalation policies ----------------------------------------------

export async function listPolicies(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.escalationPolicy.findMany({ orderBy: { severity: "asc" } })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { severity, emailTo, slackWebhookSecretName, pushUserIds, pagerOnCall } = req.body as Record<string, unknown>
    if (!VALID_SEV.includes(severity as typeof VALID_SEV[number])) throw badRequest(`severity ∈ ${VALID_SEV.join("|")}`)
    const data = {
      emailTo:                Array.isArray(emailTo)     ? emailTo.map(String)     : [],
      slackWebhookSecretName: typeof slackWebhookSecretName === "string" ? slackWebhookSecretName : null,
      pushUserIds:            Array.isArray(pushUserIds) ? pushUserIds.map(String) : [],
      pagerOnCall:            pagerOnCall === true,
    }
    const row = await prisma.escalationPolicy.upsert({
      where:  { severity: severity as string },
      update: data,
      create: { severity: severity as string, ...data },
    })
    await adminAuditR(req, res, {
      action: "escalation.upsert", targetType: "EscalationPolicy", targetId: row.id,
      metadata: { severity, actorId },
    })
    res.status(200).json({ policy: row })
  } catch (err) { next(err) }
}
