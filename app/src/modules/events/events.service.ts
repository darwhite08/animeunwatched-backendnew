import { prisma } from "../../config/prisma";
import { notFound, forbidden, badReq } from "../../lib/errors";
import { getIo } from "../../realtime/io-instance";
import { pushToUser } from "../../lib/push";

// Club events (watch-parties / AMAs / game nights). Built on ClubEvent +
// ClubEventRSVP. Reuses the per-user socket room + push for reminders/notifs.

type EventKind = "WATCH_PARTY" | "AMA" | "GAME_NIGHT" | "GENERAL";
type RSVP = "GOING" | "MAYBE" | "NOT_GOING";

async function clubBySlug(slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!club) throw notFound("Club not found");
  return club;
}
async function memberRole(clubId: string, userId: string) {
  const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId } }, select: { role: true } });
  return m?.role ?? null;
}

const EVENT_SELECT = {
  id: true, clubId: true, creatorId: true, title: true, description: true, kind: true,
  animeMalId: true, episodeNumber: true, startsAt: true, endsAt: true, location: true, createdAt: true,
  creator: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} as const;

async function shape(ev: any, userId?: string) {
  const counts = await prisma.clubEventRSVP.groupBy({ by: ["status"], where: { eventId: ev.id }, _count: true });
  const rsvp = { GOING: 0, MAYBE: 0, NOT_GOING: 0 } as Record<RSVP, number>;
  for (const c of counts) rsvp[c.status as RSVP] = c._count;
  let myStatus: RSVP | null = null;
  if (userId) {
    const mine = await prisma.clubEventRSVP.findUnique({ where: { eventId_userId: { eventId: ev.id, userId } }, select: { status: true } });
    myStatus = (mine?.status as RSVP) ?? null;
  }
  return { ...ev, rsvpCounts: rsvp, myRsvp: myStatus };
}

export async function listClubEvents(slug: string, userId: string | undefined, filter: "upcoming" | "past") {
  const club = await clubBySlug(slug);
  const now = new Date();
  const events = await prisma.clubEvent.findMany({
    where: { clubId: club.id, ...(filter === "past" ? { startsAt: { lt: now } } : { OR: [{ startsAt: { gte: now } }, { endsAt: { gte: now } }] }) },
    orderBy: { startsAt: filter === "past" ? "desc" : "asc" },
    take: 50,
    select: EVENT_SELECT,
  });
  return { events: await Promise.all(events.map((e) => shape(e, userId))) };
}

export async function getEvent(eventId: string, userId?: string) {
  const ev = await prisma.clubEvent.findUnique({ where: { id: eventId }, select: EVENT_SELECT });
  if (!ev) throw notFound("Event not found");
  return { event: await shape(ev, userId) };
}

export async function createClubEvent(userId: string, slug: string, dto: {
  title: string; description?: string; kind?: EventKind; animeMalId?: number; episodeNumber?: number;
  startsAt: string; endsAt?: string; location?: string;
}) {
  const club = await clubBySlug(slug);
  const role = await memberRole(club.id, userId);
  if (!role) throw forbidden("Join the club to create events");
  const startsAt = new Date(dto.startsAt);
  if (isNaN(+startsAt)) throw badReq("Invalid start time");
  const ev = await prisma.clubEvent.create({
    data: {
      clubId: club.id, creatorId: userId, title: dto.title.trim(), description: dto.description,
      kind: dto.kind ?? "WATCH_PARTY", animeMalId: dto.animeMalId, episodeNumber: dto.episodeNumber,
      startsAt, endsAt: dto.endsAt ? new Date(dto.endsAt) : null, location: dto.location,
    },
    select: EVENT_SELECT,
  });
  // Creator auto-RSVPs GOING + earns club XP.
  await prisma.clubEventRSVP.create({ data: { eventId: ev.id, userId, status: "GOING" } });
  await awardClubXp(club.id, userId, 5);
  // Notify + live-refresh other members.
  void notifyClub(club.id, userId, { title: club.name, body: `New event: ${ev.title}`, data: { type: "club_event", slug, eventId: ev.id } });
  void emitClubUpdate(club.id, "event");
  return shape(ev, userId);
}

export async function updateEvent(userId: string, eventId: string, patch: Record<string, unknown>) {
  const ev = await prisma.clubEvent.findUnique({ where: { id: eventId }, select: { id: true, clubId: true, creatorId: true } });
  if (!ev) throw notFound("Event not found");
  const role = await memberRole(ev.clubId, userId);
  if (ev.creatorId !== userId && role !== "ADMIN" && role !== "MOD") throw forbidden("Can't edit this event");
  const data: Record<string, unknown> = {};
  for (const k of ["title", "description", "kind", "animeMalId", "episodeNumber", "location"]) if (patch[k] !== undefined) data[k] = patch[k];
  if (patch.startsAt) data.startsAt = new Date(patch.startsAt as string);
  if (patch.endsAt !== undefined) data.endsAt = patch.endsAt ? new Date(patch.endsAt as string) : null;
  const updated = await prisma.clubEvent.update({ where: { id: eventId }, data, select: EVENT_SELECT });
  void emitClubUpdate(ev.clubId, "event");
  return shape(updated, userId);
}

export async function deleteEvent(userId: string, eventId: string) {
  const ev = await prisma.clubEvent.findUnique({ where: { id: eventId }, select: { clubId: true, creatorId: true } });
  if (!ev) throw notFound("Event not found");
  const role = await memberRole(ev.clubId, userId);
  if (ev.creatorId !== userId && role !== "ADMIN" && role !== "MOD") throw forbidden("Can't delete this event");
  await prisma.clubEvent.delete({ where: { id: eventId } });
  void emitClubUpdate(ev.clubId, "event");
  return { ok: true };
}

export async function rsvp(userId: string, eventId: string, status: RSVP) {
  const ev = await prisma.clubEvent.findUnique({ where: { id: eventId }, select: { clubId: true } });
  if (!ev) throw notFound("Event not found");
  if (!(await memberRole(ev.clubId, userId))) throw forbidden("Join the club to RSVP");
  await prisma.clubEventRSVP.upsert({
    where: { eventId_userId: { eventId, userId } },
    update: { status }, create: { eventId, userId, status },
  });
  void emitClubUpdate(ev.clubId, "event");
  return getEvent(eventId, userId);
}

// ── shared helpers (exported for reuse by clubs module) ──────────────────────
export async function awardClubXp(clubId: string, userId: string, amount: number) {
  try {
    await prisma.clubMember.update({ where: { userId_clubId: { userId, clubId } }, data: { xp: { increment: amount }, lastXpAt: new Date() } });
  } catch { /* not a member yet — ignore */ }
}

/**
 * Lightweight realtime fan-out: tell every club member's socket that something
 * in the club changed so open club screens can refetch (threads / members /
 * events / leaderboard / club meta). No push — purely for live cache refresh.
 */
export async function emitClubUpdate(clubId: string, kind: "thread" | "reply" | "member" | "event" | "club" | "announcement" | "poll") {
  try {
    const io = getIo();
    if (!io) return;
    const members = await prisma.clubMember.findMany({ where: { clubId }, select: { userId: true } });
    for (const m of members) io.to(`user:${m.userId}`).emit("club.update", { clubId, kind });
  } catch { /* best-effort */ }
}

export async function notifyClub(clubId: string, actorId: string, notif: { title: string; body: string; data?: Record<string, unknown> }) {
  try {
    const members = await prisma.clubMember.findMany({ where: { clubId, userId: { not: actorId } }, select: { userId: true } });
    const io = getIo();
    for (const m of members) {
      io?.to(`user:${m.userId}`).emit("club.notify", notif);
      void pushToUser(m.userId, notif);
    }
  } catch { /* best-effort */ }
}
