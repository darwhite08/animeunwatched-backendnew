import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { auditDelete } from "../../lib/audit";
import { broadcastThreadReply, broadcastAnimeThreadCreated } from "../../realtime/broadcast";
import type { CreateThreadDto, UpdateThreadDto, CreateReplyDto } from "./threads.schema";

// ─── Shared select ────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  verifiedKind: true,
} as const;

// ─── getById ──────────────────────────────────────────────────────────────────

export async function getById(id: string, userId?: string) {
  const thread = await prisma.thread.findUnique({
    where: { id },
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
      // Surface the parent so the frontend can render a correct breadcrumb:
      // anime threads link back to the anime, club threads to the club.
      club:  { select: { slug: true, name: true } },
      anime: { select: { malId: true, title: true, titleEnglish: true } },
    },
  });

  if (!thread) throw notFound("Thread not found");

  const reactions = (await reactionsFor([id], userId)).get(id) ?? [];
  // If this is a club thread, surface whether the viewer can moderate it.
  let canModerate = false;
  if (userId && thread.clubId) {
    if (thread.authorId === userId) canModerate = true;
    else {
      const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: thread.clubId } }, select: { role: true } });
      canModerate = m?.role === "ADMIN" || m?.role === "MOD";
    }
  }
  return { thread: { ...thread, reactions, canModerate } };
}

// ─── createClubThread ─────────────────────────────────────────────────────────

export async function createClubThread(
  authorId: string,
  clubSlug: string,
  dto: CreateThreadDto,
) {
  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) throw notFound("Club not found");

  const membership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: authorId, clubId: club.id } },
  });
  if (!membership) throw forbidden("You must be a member of this club to post a thread");
  if (membership.mutedUntil && membership.mutedUntil > new Date()) throw forbidden("You're muted in this club");

  // Announcements are mod/admin-only.
  let kind = dto.kind ?? (dto.title.startsWith("[CHALLENGE]") ? "CHALLENGE" : "DISCUSSION");
  if (kind === "ANNOUNCEMENT" && membership.role !== "ADMIN" && membership.role !== "MOD") {
    throw forbidden("Only admins can post announcements");
  }

  const thread = await prisma.thread.create({
    data: {
      title: dto.title,
      content: dto.content,
      authorId,
      clubId: club.id,
      kind: kind as "DISCUSSION" | "ANNOUNCEMENT" | "CHALLENGE" | "EPISODE",
      ...(kind === "ANNOUNCEMENT" ? { isPinned: true } : {}),
      ...(Array.isArray(dto.tags) ? { tags: dto.tags.map((t) => String(t).trim().toLowerCase().replace(/^#/, "")).filter(Boolean).slice(0, 5) } : {}),
    },
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
    },
  });

  // Club XP for posting (+5) + live refresh for members.
  try {
    const { awardClubXp, notifyClub, emitClubUpdate } = await import("../events/events.service");
    await awardClubXp(club.id, authorId, 5);
    void emitClubUpdate(club.id, kind === "ANNOUNCEMENT" ? "announcement" : "thread");
    if (kind === "ANNOUNCEMENT") void notifyClub(club.id, authorId, { title: club.name, body: `📢 ${dto.title}`, data: { type: "club_announcement", slug: clubSlug, threadId: thread.id } });
  } catch { /* best-effort */ }

  return { thread };
}

// ─── createAnimeThread ────────────────────────────────────────────────────────

export async function createAnimeThread(
  authorId: string,
  malId: number,
  dto: CreateThreadDto,
) {
  const anime = await prisma.anime.findUnique({ where: { malId } });
  if (!anime) throw notFound("Anime not found");

  const thread = await prisma.thread.create({
    data: {
      title: dto.title,
      content: dto.content,
      authorId,
      animeId: anime.id,
    },
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
    },
  });

  // Live-push to everyone viewing this anime's page so the discussion list
  // updates in real time without a refetch.
  void broadcastAnimeThreadCreated(malId, thread);

  return { thread };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(
  id: string,
  userId: string,
  role: string,
  dto: UpdateThreadDto,
) {
  const thread = await prisma.thread.findUnique({ where: { id } });
  if (!thread) throw notFound("Thread not found");

  const canEdit =
    thread.authorId === userId || role === "MOD" || role === "ADMIN";
  if (!canEdit) throw forbidden("Not allowed to edit this thread");

  const updated = await prisma.thread.update({
    where: { id },
    data: dto,
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
    },
  });

  return { thread: updated };
}

// ─── deleteThread ─────────────────────────────────────────────────────────────

export async function deleteThread(id: string, userId: string, role: string) {
  const thread = await prisma.thread.findUnique({ where: { id } });
  if (!thread) throw notFound("Thread not found");

  const canDelete =
    thread.authorId === userId || role === "MOD" || role === "ADMIN";
  if (!canDelete) throw forbidden("Not allowed to delete this thread");

  await prisma.thread.delete({ where: { id } });

  auditDelete("thread_deleted", {
    actorId:    userId,
    targetType: "Thread",
    targetId:   id,
    extra: thread.authorId !== userId ? { byMod: true, originalAuthorId: thread.authorId } : undefined,
  });
}

// ─── getReplies ───────────────────────────────────────────────────────────────

export async function getReplies(threadId: string, page = 1, limit = 50, userId?: string) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread) throw notFound("Thread not found");

  const skip = (page - 1) * limit;
  const [replies, total] = await prisma.$transaction([
    prisma.threadReply.findMany({
      where: { threadId },
      skip,
      take: limit,
      orderBy: { createdAt: "asc" },
      include: {
        author: { select: authorSelect },
      },
    }),
    prisma.threadReply.count({ where: { threadId } }),
  ]);

  const rmap = await reactionsFor(replies.map((r) => r.id), userId);
  const data = replies.map((r) => ({ ...r, reactions: rmap.get(r.id) ?? [] }));
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ─── createReply ──────────────────────────────────────────────────────────────

export async function createReply(
  threadId: string,
  authorId: string,
  dto: CreateReplyDto,
) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread) throw notFound("Thread not found");

  if (thread.isLocked) throw forbidden("This thread is locked");

  // Muted club members can't reply in that club.
  if (thread.clubId) {
    const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId: authorId, clubId: thread.clubId } }, select: { mutedUntil: true } });
    if (m?.mutedUntil && m.mutedUntil > new Date()) throw forbidden("You're muted in this club");
  }

  // Validate parentId belongs to the same thread
  if (dto.parentId) {
    const parent = await prisma.threadReply.findUnique({ where: { id: dto.parentId }, select: { threadId: true } });
    if (!parent || parent.threadId !== threadId) {
      const { badReq: br } = await import("../../lib/errors");
      throw br("parentId does not belong to this thread");
    }
  }

  const reply = await prisma.threadReply.create({
    data: {
      threadId,
      authorId,
      content: dto.content,
      ...(dto.parentId ? { parentId: dto.parentId } : {}),
    },
    include: {
      author: { select: authorSelect },
    },
  });

  // Club XP for replying (+2) + live refresh.
  if (thread.clubId) {
    try { const { awardClubXp, emitClubUpdate } = await import("../events/events.service"); await awardClubXp(thread.clubId, authorId, 2); void emitClubUpdate(thread.clubId, "reply"); } catch { /* best-effort */ }
  }

  // Realtime: anyone watching this thread sees the new reply instantly
  broadcastThreadReply(threadId, reply);

  return { reply };
}

// ─── getAnimeThreads ──────────────────────────────────────────────────────────

export async function getAnimeThreads(malId: number, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const anime = await prisma.anime.findUnique({ where: { malId }, select: { id: true } });
  if (!anime) return { data: [], meta: { total: 0, page, limit, pages: 0 } };

  const [data, total] = await prisma.$transaction([
    prisma.thread.findMany({
      where: { animeId: anime.id },
      skip, take: limit,
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      include: {
        author: { select: authorSelect },
        _count: { select: { replies: true } },
      },
    }),
    prisma.thread.count({ where: { animeId: anime.id } }),
  ]);

  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ─── getClubThreads ───────────────────────────────────────────────────────────

export async function getClubThreads(slug: string, page = 1, limit = 20, userId?: string) {
  const skip = (page - 1) * limit;
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, visibility: true } });
  if (!club) return { data: [], meta: { total: 0, page, limit, pages: 0 } };

  // Private clubs only expose their threads to members.
  if (club.visibility === "PRIVATE") {
    const member = userId ? await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: club.id } }, select: { userId: true } }) : null;
    if (!member) return { data: [], meta: { total: 0, page, limit, pages: 0 } };
  }

  const [data, total] = await prisma.$transaction([
    prisma.thread.findMany({
      where: { clubId: club.id },
      skip, take: limit,
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      include: { author: { select: authorSelect }, _count: { select: { replies: true } } },
    }),
    prisma.thread.count({ where: { clubId: club.id } }),
  ]);

  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ─── reactions ──────────────────────────────────────────────────────────────
type ReactionSummary = { emoji: string; count: number; reactedByMe: boolean };

/** Fetch reaction summaries for a set of targets, keyed by targetId. */
export async function reactionsFor(targetIds: string[], userId?: string): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (!targetIds.length) return out;
  const rows = await prisma.threadReaction.findMany({
    where: { targetId: { in: targetIds } },
    select: { targetId: true, emoji: true, userId: true },
  });
  const byTarget = new Map<string, Map<string, ReactionSummary>>();
  for (const r of rows) {
    const m = byTarget.get(r.targetId) ?? new Map<string, ReactionSummary>();
    const e = m.get(r.emoji) ?? { emoji: r.emoji, count: 0, reactedByMe: false };
    e.count += 1;
    if (userId && r.userId === userId) e.reactedByMe = true;
    m.set(r.emoji, e);
    byTarget.set(r.targetId, m);
  }
  for (const [tid, m] of byTarget) out.set(tid, [...m.values()]);
  return out;
}

/** Toggle a reaction on a thread or reply. Returns the target's reaction summary. */
export async function setReaction(targetId: string, targetType: "thread" | "reply", userId: string, emoji: string) {
  const exists = targetType === "thread"
    ? await prisma.thread.findUnique({ where: { id: targetId }, select: { id: true } })
    : await prisma.threadReply.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!exists) throw notFound("Not found");

  const existing = await prisma.threadReaction.findUnique({ where: { targetId_userId_emoji: { targetId, userId, emoji } } });
  if (existing) await prisma.threadReaction.delete({ where: { id: existing.id } });
  else await prisma.threadReaction.create({ data: { targetId, targetType, userId, emoji } });
  const map = await reactionsFor([targetId], userId);
  return { reactions: map.get(targetId) ?? [] };
}

// ─── thread lock (author or club mod/admin) ───────────────────────────────────
export async function setThreadLock(userId: string, threadId: string, locked: boolean) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId }, select: { id: true, clubId: true, authorId: true } });
  if (!thread) throw notFound("Thread not found");
  let allowed = thread.authorId === userId;
  if (!allowed && thread.clubId) {
    const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: thread.clubId } }, select: { role: true } });
    allowed = m?.role === "ADMIN" || m?.role === "MOD";
  }
  if (!allowed) throw forbidden("Only the author or a club mod can lock this thread");
  const updated = await prisma.thread.update({ where: { id: threadId }, data: { isLocked: locked }, select: { id: true, isLocked: true } });
  return { thread: updated };
}
