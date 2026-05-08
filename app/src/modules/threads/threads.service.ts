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

export async function getReplies(threadId: string) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread) throw notFound("Thread not found");

  const replies = await prisma.threadReply.findMany({
    where: { threadId },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: authorSelect },
    },
  });

  return { data: replies };
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
