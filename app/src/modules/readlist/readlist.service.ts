import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import { searchManga } from "../../lib/anilist";
import type { AddMangaDto, UpdateMangaDto } from "./readlist.schema";

export async function search(q: string) {
  return { data: await searchManga(q) };
}

export async function getByUsername(usernameOrSlug: string) {
  // The profile URL uses the slug; the API also accepts the raw username.
  const user = await prisma.user.findFirst({
    where: { OR: [{ username: usernameOrSlug }, { slug: usernameOrSlug }] },
    select: { id: true },
  });
  if (!user) throw notFound("User not found");
  const data = await prisma.mangaEntry.findMany({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  return { data };
}

export async function getMine(userId: string) {
  const data = await prisma.mangaEntry.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return { data };
}

export async function add(userId: string, dto: AddMangaDto) {
  // Idempotent: re-adding an existing manga is a no-op (keeps the user's progress).
  const entry = await prisma.mangaEntry.upsert({
    where: { userId_anilistId: { userId, anilistId: dto.anilistId } },
    create: {
      userId,
      anilistId: dto.anilistId,
      title: dto.title,
      coverUrl: dto.coverUrl ?? null,
      author: dto.author ?? null,
      format: dto.format ?? null,
      totalChapters: dto.totalChapters ?? null,
      genre: dto.genre ?? null,
      status: dto.status ?? "PLAN_TO_READ",
    },
    update: {},
  });
  return { entry };
}

export async function update(userId: string, id: string, dto: UpdateMangaDto) {
  const existing = await prisma.mangaEntry.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw notFound("Entry not found");

  const data: { status?: string; progress?: number; score?: number | null } = {};
  if (dto.status !== undefined) data.status = dto.status;
  if (dto.progress !== undefined) data.progress = dto.progress;
  if (dto.score !== undefined) data.score = dto.score ?? null;
  // Marking complete with a known length auto-fills progress.
  if (dto.status === "COMPLETED" && existing.totalChapters && dto.progress === undefined) {
    data.progress = existing.totalChapters;
  }

  const entry = await prisma.mangaEntry.update({ where: { id }, data });
  return { entry };
}

export async function remove(userId: string, id: string) {
  const existing = await prisma.mangaEntry.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw notFound("Entry not found");
  await prisma.mangaEntry.delete({ where: { id } });
}
