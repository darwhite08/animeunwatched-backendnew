import { prisma } from "../config/prisma"

/**
 * Returns the admin user currently on call for the given schedule (or the
 * first active schedule if none specified). Used by the AdminAlert emitter
 * when EscalationPolicy.pagerOnCall is true.
 */
export async function getCurrentOnCall(scheduleId?: string): Promise<{ userId: string; scheduleId: string; shiftId: string } | null> {
  const now = new Date()
  const schedule = scheduleId
    ? await prisma.onCallSchedule.findUnique({ where: { id: scheduleId } })
    : await prisma.onCallSchedule.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } })
  if (!schedule) return null

  const shift = await prisma.onCallShift.findFirst({
    where: { scheduleId: schedule.id, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: "asc" },
  })
  if (!shift) return null
  return { userId: shift.userId, scheduleId: schedule.id, shiftId: shift.id }
}

/**
 * Generates a contiguous rotation: for each user in `userIds`, creates a
 * shift starting from `startsAt` lasting `rotationDays`, in order, for
 * `cycles` full cycles. Idempotent within the (scheduleId, startsAt) range
 * — does not delete existing shifts; admin should clear first if regenerating.
 */
export async function generateRotation(opts: {
  scheduleId: string
  userIds:    string[]
  startsAt:   Date
  cycles:     number
}): Promise<number> {
  const schedule = await prisma.onCallSchedule.findUnique({ where: { id: opts.scheduleId } })
  if (!schedule) return 0
  const shiftMs = schedule.rotationDays * 24 * 60 * 60_000
  let cursor = opts.startsAt.getTime()
  const rows: Array<{ scheduleId: string; userId: string; startsAt: Date; endsAt: Date }> = []
  for (let c = 0; c < opts.cycles; c++) {
    for (const userId of opts.userIds) {
      rows.push({
        scheduleId: opts.scheduleId,
        userId,
        startsAt:   new Date(cursor),
        endsAt:     new Date(cursor + shiftMs),
      })
      cursor += shiftMs
    }
  }
  if (rows.length === 0) return 0
  const r = await prisma.onCallShift.createMany({ data: rows })
  return r.count
}
