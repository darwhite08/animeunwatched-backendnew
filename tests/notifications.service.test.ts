/**
 * Notifications service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("notifications.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list returns paginated notifications", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/notifications/notifications.service");

    const mockNotifs = [{ id: "n1", type: "system", recipientId: "u1", payload: {}, read: false, createdAt: new Date() }];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockNotifs, 1]);

    const result = await list("u1", 1, 20);
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
    expect(result.meta.pages).toBe(1);
  });

  it("getUnreadCount returns count of unread notifications", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUnreadCount } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(5);

    const result = await getUnreadCount("u1");
    expect(result.count).toBe(5);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { recipientId: "u1", read: false },
    });
  });

  it("markRead throws NOT_FOUND for non-existent notification", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markRead } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(markRead("u1", "nonexistent-id")).rejects.toThrow("Notification not found");
  });

  it("markRead throws NOT_FOUND if notification belongs to a different user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markRead } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "n1",
      recipientId: "other-user",  // Different from "u1"
    });

    await expect(markRead("u1", "n1")).rejects.toThrow("Notification not found");
  });

  it("markRead updates the notification's read status", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markRead } = await import("../app/src/modules/notifications/notifications.service");

    const mockNotif = { id: "n1", recipientId: "u1", read: false, type: "system", payload: {}, createdAt: new Date() };
    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockNotif);
    (prisma.notification.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...mockNotif, read: true });

    const result = await markRead("u1", "n1");
    expect(result.notification.read).toBe(true);
  });

  it("markAllRead updates all unread notifications for a user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markAllRead } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 3 });

    const result = await markAllRead("u1");
    expect(result.updated).toBe(3);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: "u1", read: false },
      data: { read: true },
    });
  });
});
