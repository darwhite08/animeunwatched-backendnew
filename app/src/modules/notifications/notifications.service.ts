import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";

// ─── Pagination helpers ───────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(userId: string, page = 1, limit = 20) {
  const { skip, take } = paginate(page, limit);

  const [data, total] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { recipientId: userId },
      skip,
      take,
      // updatedAt so a bumped (grouped) DM notification re-sorts to the top;
      // for one-off rows updatedAt == createdAt, so ordering is unchanged.
      orderBy: { updatedAt: "desc" },
    }),
    prisma.notification.count({ where: { recipientId: userId } }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getUnreadCount ───────────────────────────────────────────────────────────

export async function getUnreadCount(userId: string) {
  const count = await prisma.notification.count({
    where: { recipientId: userId, read: false },
  });
  return { count };
}

// ─── markRead ─────────────────────────────────────────────────────────────────

export async function markRead(userId: string, id: string) {
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.recipientId !== userId) {
    throw notFound("Notification not found");
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { read: true },
  });

  return { notification: updated };
}

// ─── markAllRead ──────────────────────────────────────────────────────────────

export async function markAllRead(userId: string) {
  const { count } = await prisma.notification.updateMany({
    where: { recipientId: userId, read: false },
    data: { read: true },
  });

  return { updated: count };
}
