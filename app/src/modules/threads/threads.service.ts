import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import type { CreateThreadDto, UpdateThreadDto, CreateReplyDto } from "./threads.schema";

// ─── Shared select ────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

// ─── getById ──────────────────────────────────────────────────────────────────

export async function getById(id: string) {
  const thread = await prisma.thread.findUnique({
    where: { id },
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
    },
  });

  if (!thread) throw notFound("Thread not found");

  return { thread };
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

  const thread = await prisma.thread.create({
    data: {
      title: dto.title,
      content: dto.content,
      authorId,
      clubId: club.id,
    },
    include: {
      author: { select: authorSelect },
      _count: { select: { replies: true } },
    },
  });

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
}

// ─── getReplies ───────────────────────────────────────────────────────────────

export async function getReplies(threadId: string, page = 1, limit = 50) {
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

  return { data: replies, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
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

export async function getClubThreads(slug: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (!club) return { data: [], meta: { total: 0, page, limit, pages: 0 } };

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
