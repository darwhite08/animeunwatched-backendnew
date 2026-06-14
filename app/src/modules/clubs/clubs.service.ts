import { randomBytes } from "node:crypto";
import { prisma } from "../../config/prisma";
import { notFound, forbidden, conflict, badReq } from "../../lib/errors";
import { auditMod } from "../../lib/audit";
import { awardClubXp, emitClubUpdate } from "../events/events.service";
import type { CreateClubDto, UpdateClubDto, CreateInviteDto } from "./clubs.schema";

// ─── Shared select ────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  verifiedKind: true,
} as const;

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(page = 1, limit = 20, q?: string, category?: string) {
  const { skip, take } = paginate(page, limit);
  const and: object[] = [];
  if (q) and.push({ OR: [
    { name:        { contains: q, mode: "insensitive" as const } },
    { slug:        { contains: q, mode: "insensitive" as const } },
    { description: { contains: q, mode: "insensitive" as const } },
  ] });
  if (category) and.push({ category });
  const where = and.length ? { AND: and } : undefined;

  const [data, total] = await prisma.$transaction([
    prisma.club.findMany({
      where,
      skip,
      take,
      orderBy: { reputation: "desc" },
      include: {
        _count: { select: { members: true, threads: true } },
      },
    }),
    prisma.club.count({ where }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string, userId?: string) {
  const club = await prisma.club.findUnique({
    where: { slug },
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
      chatGroup: { select: { id: true } },
    },
  });

  if (!club) throw notFound("Den not found");

  let isMember = false;
  let myRole: "USER" | "MOD" | "ADMIN" | null = null;
  let needsOnboarding = false;
  let myJoinRequest: "PENDING" | "REJECTED" | null = null;
  let pendingRequests = 0;
  if (userId) {
    const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: club.id } }, select: { role: true, agreedRulesAt: true } });
    if (m) { isMember = true; myRole = m.role; needsOnboarding = !m.agreedRulesAt; }
    else {
      const req = await prisma.clubJoinRequest.findUnique({ where: { clubId_userId: { clubId: club.id, userId } }, select: { status: true } });
      if (req && req.status !== "APPROVED") myJoinRequest = req.status;
    }
  }
  // Mods/admins see the pending-request count so they can action the queue.
  if (myRole === "ADMIN" || myRole === "MOD") {
    pendingRequests = await prisma.clubJoinRequest.count({ where: { clubId: club.id, status: "PENDING" } });
  }

  const { chatGroup, ...rest } = club;
  // Private clubs hide their content from non-members; the client shows a lock screen.
  const locked = club.visibility === "PRIVATE" && !isMember;
  return { club: { ...rest, isMember, myRole, hasChat: !!chatGroup, needsOnboarding, locked, myJoinRequest, pendingRequests } };
}

// ─── verified badge (admin) ─────────────────────────────────────────────────────

export async function setClubVerified(slug: string, verified: boolean) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  await prisma.club.update({ where: { id: club.id }, data: { verified, verifiedAt: verified ? new Date() : null } });
  void emitClubUpdate(club.id, "club");
  return { ok: true, verified };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(ownerId: string, dto: CreateClubDto) {
  const user = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!user) throw notFound("User not found");

  if (user.reputation < 50) {
    throw forbidden("You need at least 50 reputation to create a den");
  }

  const club = await prisma.club.create({
    data: {
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      category: dto.category,
      visibility: dto.visibility ?? "PUBLIC",
      bannerUrl: dto.bannerUrl ?? null,
      avatarUrl: dto.avatarUrl ?? null,
      ownerId,
    },
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
    },
  });

  // Auto-join as ADMIN
  await prisma.clubMember.create({
    data: {
      userId: ownerId,
      clubId: club.id,
      role: "ADMIN",
    },
  });

  return { club };
}

// ─── delete ─────────────────────────────────────────────────────────────────
/**
 * Permanently delete a club. Owner-only. Members, events, invites, join
 * requests, watchlist and the chat group cascade away (schema onDelete:Cascade);
 * threads and polls are detached (clubId → null) so user content survives.
 */
export async function deleteClub(actorId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, ownerId: true } });
  if (!club) throw notFound("Den not found");
  if (club.ownerId !== actorId) throw forbidden("Only the den owner can delete this den");

  await prisma.club.delete({ where: { id: club.id } });
  return { ok: true };
}

// ─── join ─────────────────────────────────────────────────────────────────────

export async function join(userId: string, slug: string, message?: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, rules: true, welcomeMessage: true, visibility: true } });
  if (!club) throw notFound("Den not found");

  const existing = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId, clubId: club.id } },
  });
  if (existing) throw conflict("Already a member of this den");

  // Private clubs: queue a join request for a mod/admin to approve (idempotent).
  if (club.visibility === "PRIVATE") {
    const req = await prisma.clubJoinRequest.upsert({
      where: { clubId_userId: { clubId: club.id, userId } },
      update: { status: "PENDING", message: message?.slice(0, 500) ?? null, decidedAt: null, decidedById: null },
      create: { clubId: club.id, userId, message: message?.slice(0, 500) ?? null },
      select: { id: true, status: true },
    });
    void emitClubUpdate(club.id, "request");
    return { pending: true, request: req };
  }

  const membership = await prisma.clubMember.create({
    data: {
      userId,
      clubId: club.id,
      role: "USER",
    },
  });

  void emitClubUpdate(club.id, "member");

  // First-community badge (belonging is the strongest identity driver)
  void (async () => {
    const n = await prisma.clubMember.count({ where: { userId } });
    if (n === 1) await (await import("../../lib/badges")).awardBadge(userId, "FIRST_CLUB");
  })().catch(() => {});

  return { membership, requiresOnboarding: true, rules: club.rules ?? null, welcomeMessage: club.welcomeMessage ?? null };
}

// ─── private clubs: invites + join-request queue ───────────────────────────────

function inviteCode(): string {
  // URL-safe, ~8 chars, no ambiguous characters.
  return randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8);
}

/** Create a shareable invite link for a club (mod/admin). */
export async function createInvite(actorId: string, slug: string, dto: CreateInviteDto) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  await assertModerator(actorId, club.id);
  const expiresAt = dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null;
  const invite = await prisma.clubInvite.create({
    data: { clubId: club.id, code: inviteCode(), createdById: actorId, expiresAt, maxUses: dto.maxUses ?? null },
    select: { code: true, expiresAt: true, maxUses: true, uses: true },
  });
  return { invite };
}

/** Public preview of the club behind an invite code (for the join landing). */
export async function getInviteInfo(code: string) {
  const invite = await prisma.clubInvite.findUnique({
    where: { code },
    select: { expiresAt: true, maxUses: true, uses: true, club: { select: { slug: true, name: true, description: true, avatarUrl: true, bannerUrl: true, _count: { select: { members: true } } } } },
  });
  if (!invite) throw notFound("Invite not found");
  const expired = !!(invite.expiresAt && invite.expiresAt < new Date());
  const used = invite.maxUses != null && invite.uses >= invite.maxUses;
  return { valid: !expired && !used, expired, used, club: invite.club };
}

/** Join a club via a valid invite code, bypassing approval. */
export async function joinViaInvite(userId: string, code: string) {
  const invite = await prisma.clubInvite.findUnique({ where: { code }, include: { club: { select: { id: true, rules: true, welcomeMessage: true } } } });
  if (!invite) throw notFound("Invite not found");
  if (invite.expiresAt && invite.expiresAt < new Date()) throw forbidden("This invite has expired");
  if (invite.maxUses != null && invite.uses >= invite.maxUses) throw forbidden("This invite has reached its limit");

  const existing = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: invite.club.id } } });
  if (existing) throw conflict("Already a member of this den");

  const [membership] = await prisma.$transaction([
    prisma.clubMember.create({ data: { userId, clubId: invite.club.id, role: "USER" } }),
    prisma.clubInvite.update({ where: { code }, data: { uses: { increment: 1 } } }),
    // If they had a pending request, mark it resolved.
    prisma.clubJoinRequest.updateMany({ where: { clubId: invite.club.id, userId, status: "PENDING" }, data: { status: "APPROVED", decidedAt: new Date() } }),
  ]);
  void emitClubUpdate(invite.club.id, "member");
  return { membership, requiresOnboarding: true, rules: invite.club.rules ?? null, welcomeMessage: invite.club.welcomeMessage ?? null };
}

/** List pending join requests for a club (mod/admin). */
export async function listJoinRequests(actorId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  await assertModerator(actorId, club.id);
  const requests = await prisma.clubJoinRequest.findMany({
    where: { clubId: club.id, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true, message: true, createdAt: true, user: { select: authorSelect } },
  });
  return { requests };
}

/** Approve or reject a pending join request (mod/admin). */
export async function decideJoinRequest(actorId: string, slug: string, targetUserId: string, approve: boolean) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  await assertModerator(actorId, club.id);
  const req = await prisma.clubJoinRequest.findUnique({ where: { clubId_userId: { clubId: club.id, userId: targetUserId } }, select: { status: true } });
  if (!req) throw notFound("Join request not found");
  if (req.status !== "PENDING") throw badReq("This request has already been decided");

  if (approve) {
    const already = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: targetUserId, clubId: club.id } }, select: { userId: true } });
    if (!already) await prisma.clubMember.create({ data: { userId: targetUserId, clubId: club.id, role: "USER" } });
  }
  await prisma.clubJoinRequest.update({
    where: { clubId_userId: { clubId: club.id, userId: targetUserId } },
    data: { status: approve ? "APPROVED" : "REJECTED", decidedAt: new Date(), decidedById: actorId },
  });
  auditMod("mod_action_applied", { actorId, targetUserId, targetType: "Club", targetId: club.id, action: approve ? "club_request_approved" : "club_request_rejected" });
  void emitClubUpdate(club.id, approve ? "member" : "request");
  return { ok: true, approved: approve };
}

// Mark onboarding complete (rules agreed) + post a system "joined" message.
export async function onboard(userId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, chatGroup: { select: { id: true } } } });
  if (!club) throw notFound("Den not found");
  const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: club.id } }, select: { onboardedAt: true } });
  if (!m) throw forbidden("Join the den first");
  const now = new Date();
  await prisma.clubMember.update({ where: { userId_clubId: { userId, clubId: club.id } }, data: { agreedRulesAt: now, onboardedAt: m.onboardedAt ?? now } });
  if (!m.onboardedAt) {
    await awardClubXp(club.id, userId, 3);
    if (club.chatGroup) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
      await prisma.groupMessage.create({ data: { groupId: club.chatGroup.id, senderId: null, type: "SYSTEM", body: `${user?.displayName ?? user?.username ?? "Someone"} joined the den` } });
    }
    void emitClubUpdate(club.id, "member");
  }
  return { ok: true };
}

// ─── moderation (mod/admin) ──────────────────────────────────────────────────
async function assertModerator(actorId: string, clubId: string) {
  const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: actorId, clubId } }, select: { role: true } });
  if (!m || (m.role !== "ADMIN" && m.role !== "MOD")) throw forbidden("Moderators only");
  return m;
}

/** Mute (minutes > 0) or unmute (minutes = 0/undefined) a member. Muting adds a strike. */
export async function muteMember(actorId: string, slug: string, targetId: string, minutes?: number) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, ownerId: true } });
  if (!club) throw notFound("Den not found");
  await assertModerator(actorId, club.id);
  if (targetId === club.ownerId) throw forbidden("Can't mute the owner");
  const target = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: targetId, clubId: club.id } }, select: { role: true } });
  if (!target) throw notFound("Member not found");
  if (target.role === "ADMIN") throw forbidden("Can't mute an admin");
  const mutedUntil = minutes && minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  await prisma.clubMember.update({
    where: { userId_clubId: { userId: targetId, clubId: club.id } },
    data: { mutedUntil, ...(mutedUntil ? { strikes: { increment: 1 } } : {}) },
  });
  auditMod("mod_action_applied", { actorId, targetUserId: targetId, targetType: "Club", targetId: club.id, action: mutedUntil ? `club_mute:${minutes}m` : "club_unmute" });
  void emitClubUpdate(club.id, "member");
  return { ok: true, mutedUntil };
}

/** Remove (kick) a member from the club + its chat room. Mod/admin only. */
export async function removeClubMember(actorId: string, slug: string, targetId: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, ownerId: true, chatGroup: { select: { id: true } } } });
  if (!club) throw notFound("Den not found");
  const actor = await assertModerator(actorId, club.id);
  if (targetId === club.ownerId) throw forbidden("Can't remove the owner");
  const target = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: targetId, clubId: club.id } }, select: { role: true } });
  if (!target) throw notFound("Member not found");
  if (target.role === "ADMIN" && actor.role !== "ADMIN") throw forbidden("Only an admin can remove an admin");
  await prisma.clubMember.delete({ where: { userId_clubId: { userId: targetId, clubId: club.id } } });
  if (club.chatGroup) {
    await prisma.groupMember.updateMany({ where: { groupId: club.chatGroup.id, userId: targetId, leftAt: null }, data: { leftAt: new Date() } });
  }
  auditMod("mod_action_applied", { actorId, targetUserId: targetId, targetType: "Club", targetId: club.id, action: "club_remove" });
  void emitClubUpdate(club.id, "member");
  return { ok: true };
}

// ─── club polls ────────────────────────────────────────────────────────────
export async function listClubPolls(slug: string, userId?: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const { listForClub } = await import("../polls/polls.service");
  return listForClub(club.id, userId);
}

export async function createClubPoll(userId: string, slug: string, dto: { question: string; options: string[]; expiresInDays?: number }) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const membership = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: club.id } }, select: { userId: true } });
  if (!membership) throw forbidden("Join the club to create a poll");
  if (!dto.question?.trim() || !Array.isArray(dto.options) || dto.options.filter((o) => o.trim()).length < 2) {
    throw notFound("A poll needs a question and at least 2 options");
  }
  const { create } = await import("../polls/polls.service");
  const result = await create(userId, { question: dto.question.trim(), options: dto.options.map((o) => o.trim()).filter(Boolean), expiresInDays: dto.expiresInDays ?? 7 } as never, club.id);
  await awardClubXp(club.id, userId, 5);
  void emitClubUpdate(club.id, "poll");
  return result;
}

export async function leaderboard(slug: string, period: "week" | "all") {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const where = period === "week"
    ? { clubId: club.id, lastXpAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) } }
    : { clubId: club.id };
  const rows = await prisma.clubMember.findMany({
    where, orderBy: { xp: "desc" }, take: 50,
    select: { xp: true, role: true, user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  return { leaderboard: rows.map((r, i) => ({ rank: i + 1, xp: r.xp, role: r.role, user: r.user })) };
}

// ─── activity feed (P2) — merged recent threads/events/members/watchlist ───────

export async function getClubActivity(slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const since = new Date(Date.now() - 60 * 24 * 60 * 60_000); // last 60 days

  const [threads, events, members, watch] = await Promise.all([
    prisma.thread.findMany({ where: { clubId: club.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 15, select: { id: true, title: true, kind: true, createdAt: true, author: { select: authorSelect } } }),
    prisma.clubEvent.findMany({ where: { clubId: club.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, title: true, startsAt: true, createdAt: true, creator: { select: authorSelect } } }),
    prisma.clubMember.findMany({ where: { clubId: club.id, joinedAt: { gte: since } }, orderBy: { joinedAt: "desc" }, take: 10, select: { joinedAt: true, user: { select: authorSelect } } }),
    prisma.clubWatchlistItem.findMany({ where: { clubId: club.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, malId: true, title: true, createdAt: true, addedBy: { select: authorSelect } } }),
  ]);

  type Item = { type: string; at: string; actor: typeof threads[number]["author"] | null; text: string; link?: string };
  const items: Item[] = [
    ...threads.map((t) => ({ type: t.kind === "ANNOUNCEMENT" ? "announcement" : "thread", at: t.createdAt.toISOString(), actor: t.author, text: t.title.replace(/^\[CHALLENGE\]\s*/, ""), link: `/threads/${t.id}` })),
    ...events.map((e) => ({ type: "event", at: e.createdAt.toISOString(), actor: e.creator, text: e.title })),
    ...members.map((m) => ({ type: "member", at: m.joinedAt.toISOString(), actor: m.user, text: "joined the club" })),
    ...watch.map((w) => ({ type: "watchlist", at: w.createdAt.toISOString(), actor: w.addedBy, text: w.title, link: `/anime/${w.malId}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40);

  return { items };
}

// ─── shared watchlist (P2) ─────────────────────────────────────────────────────

export async function getWatchlist(slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const items = await prisma.clubWatchlistItem.findMany({
    where: { clubId: club.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, malId: true, title: true, imageUrl: true, createdAt: true, addedBy: { select: authorSelect } },
  });
  return { items };
}

export async function addToWatchlist(actorId: string, slug: string, dto: { malId: number; title: string; imageUrl?: string }) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const membership = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: actorId, clubId: club.id } }, select: { userId: true } });
  if (!membership) throw forbidden("Join the club to add to its watchlist");
  if (!dto.malId || !dto.title?.trim()) throw badReq("malId and title are required");
  const item = await prisma.clubWatchlistItem.upsert({
    where: { clubId_malId: { clubId: club.id, malId: dto.malId } },
    update: {},
    create: { clubId: club.id, malId: dto.malId, title: dto.title.trim().slice(0, 200), imageUrl: dto.imageUrl ?? null, addedById: actorId },
    select: { id: true, malId: true, title: true, imageUrl: true, createdAt: true, addedBy: { select: authorSelect } },
  });
  void emitClubUpdate(club.id, "club");
  return { item };
}

export async function removeFromWatchlist(actorId: string, slug: string, malId: number) {
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) throw notFound("Den not found");
  const item = await prisma.clubWatchlistItem.findUnique({ where: { clubId_malId: { clubId: club.id, malId } }, select: { addedById: true } });
  if (!item) throw notFound("Not on the watchlist");
  if (item.addedById !== actorId) await assertModerator(actorId, club.id); // adder, or a mod
  await prisma.clubWatchlistItem.delete({ where: { clubId_malId: { clubId: club.id, malId } } });
  void emitClubUpdate(club.id, "club");
  return { ok: true };
}

// ─── leave ────────────────────────────────────────────────────────────────────

export async function leave(userId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, include: { chatGroup: { select: { id: true } } } });
  if (!club) throw notFound("Den not found");

  if (club.ownerId === userId) {
    throw forbidden("Club owner cannot leave; transfer ownership first");
  }

  await prisma.clubMember.deleteMany({
    where: { userId, clubId: club.id },
  });
  void emitClubUpdate(club.id, "member");
  // Drop them from the club chat room too (soft-leave so history stays attributed).
  if (club.chatGroup) {
    await prisma.groupMember.updateMany({
      where: { groupId: club.chatGroup.id, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
  }
}

// ─── club chat (realtime group room backed by ClubMember) ──────────────────────

function clubRoleToGroupRole(clubRole: string, isOwner: boolean): "OWNER" | "ADMIN" | "MEMBER" {
  if (isOwner) return "OWNER";
  if (clubRole === "ADMIN" || clubRole === "MOD") return "ADMIN";
  return "MEMBER";
}

/**
 * Resolve (and lazily create) the club's chat room. The room is a GroupConversation
 * with clubId set; its membership mirrors ClubMember — the caller is auto-added as a
 * GroupMember on first open (handles all existing club members without bulk sync).
 * Returns the groupId the client opens via the normal group thread.
 */
export async function getOrCreateClubChat(userId: string, slug: string) {
  const club = await prisma.club.findUnique({
    where: { slug },
    include: { chatGroup: { select: { id: true } } },
  });
  if (!club) throw notFound("Den not found");

  const membership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId, clubId: club.id } },
  });
  if (!membership) throw forbidden("Join the club to access its chat");

  // Create the backing group on first access.
  let groupId = club.chatGroup?.id;
  if (!groupId) {
    const created = await prisma.groupConversation.create({
      data: {
        title: club.name, ownerId: club.ownerId, clubId: club.id, isE2EE: false,
        members: { create: { userId, role: clubRoleToGroupRole(membership.role, club.ownerId === userId), addedBy: userId } },
      },
      select: { id: true },
    });
    groupId = created.id;
    // Seed a system message.
    await prisma.groupMessage.create({ data: { groupId, senderId: null, type: "SYSTEM", body: "Club chat created" } });
    return { groupId };
  }

  // Ensure the caller is an active member of the room (lazy join / rejoin).
  const gm = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { leftAt: true } });
  if (!gm) {
    await prisma.groupMember.create({ data: { groupId, userId, role: clubRoleToGroupRole(membership.role, club.ownerId === userId), addedBy: userId } });
  } else if (gm.leftAt) {
    await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { leftAt: null } });
  }
  return { groupId };
}

// ─── setMemberRole ────────────────────────────────────────────────────────────

export async function setMemberRole(
  actorId: string,
  slug: string,
  targetUserId: string,
  role: "USER" | "MOD" | "ADMIN",
) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Den not found");

  const actorMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: actorId, clubId: club.id } },
  });

  if (!actorMembership || actorMembership.role !== "ADMIN") {
    throw forbidden("Only club admins can change member roles");
  }

  const targetMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: targetUserId, clubId: club.id } },
  });
  if (!targetMembership) throw notFound("Target user is not a member of this club");

  const updated = await prisma.clubMember.update({
    where: { userId_clubId: { userId: targetUserId, clubId: club.id } },
    data: { role },
  });

  auditMod("club_role_changed", {
    actorId:      actorId,
    targetUserId: targetUserId,
    targetType:   "Club",
    targetId:     club.id,
    action:       `set_role:${role}`,
    extra:        { previousRole: targetMembership.role },
  });

  void emitClubUpdate(club.id, "member");
  return { membership: updated };
}

// ─── getClubMembers ───────────────────────────────────────────────────────────

export async function getClubMembers(slug: string, page: number, limit: number) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Den not found");

  const [members, total, topXp] = await prisma.$transaction([
    prisma.clubMember.findMany({
      where: { clubId: club.id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            reputation: true,
            verifiedKind: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.clubMember.count({ where: { clubId: club.id } }),
    // Top-3 contributors by club XP, for a "Top contributor" badge.
    prisma.clubMember.findMany({ where: { clubId: club.id, xp: { gt: 0 } }, orderBy: { xp: "desc" }, take: 3, select: { userId: true } }),
  ]);

  const topSet = new Set(topXp.map((m) => m.userId));
  const now = Date.now();
  const withBadges = members.map((m) => {
    const badges: string[] = [];
    if (club.ownerId === m.userId) badges.push("founder");
    else if (m.role === "ADMIN") badges.push("admin");
    else if (m.role === "MOD") badges.push("mod");
    if (m.user.verifiedKind) badges.push("verified");
    if (topSet.has(m.userId)) badges.push("top");
    if (now - new Date(m.joinedAt).getTime() > 30 * 24 * 60 * 60_000) badges.push("veteran");
    return { ...m, badges };
  });

  return { data: withBadges, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(slug: string, actorId: string, dto: UpdateClubDto) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Den not found");

  const actorMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: actorId, clubId: club.id } },
  });

  if (!actorMembership || actorMembership.role !== "ADMIN") {
    throw forbidden("Only club admins can update club details");
  }

  const updated = await prisma.club.update({
    where: { slug },
    data: dto,
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
    },
  });

  void emitClubUpdate(updated.id, "club");
  return { club: updated };
}
