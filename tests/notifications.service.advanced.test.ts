/**
 * Advanced notifications service tests.
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
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/realtime/io-instance", () => ({
  getIo: vi.fn().mockReturnValue(null), // no socket in tests
}));

describe("notifications.service — createNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates notification in DB", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createNotification, NotificationType } = await import("../app/src/lib/notify");

    (prisma.notification.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "n1",
      type: NotificationType.SYSTEM,
      payload: { message: "Hello" },
      read: false,
      createdAt: new Date(),
    });

    await createNotification({
      recipientId: "user-1",
      type: NotificationType.SYSTEM,
      payload: { message: "Hello" },
    });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientId: "user-1",
          type: "system",
        }),
      })
    );
  });
});

describe("notifications.service — list pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("paginates correctly for page 2", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 50]);

    const result = await list("u1", 2, 10);

    expect(result.meta.page).toBe(2);
    expect(result.meta.limit).toBe(10);
    expect(result.meta.total).toBe(50);
    expect(result.meta.pages).toBe(5);
  });

  it("calculates pages correctly for partial last page", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 21]);

    const result = await list("u1", 1, 10);
    expect(result.meta.pages).toBe(3); // ceil(21/10) = 3
  });
});

describe("notifications.service — getUnreadCount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when no unread notifications", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUnreadCount } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

    const result = await getUnreadCount("u1");
    expect(result.count).toBe(0);
  });

  it("returns correct count when notifications exist", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUnreadCount } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(7);

    const result = await getUnreadCount("u1");
    expect(result.count).toBe(7);
  });
});

describe("notifications.service — markAllRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns updated count of 0 when all already read", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markAllRead } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });

    const result = await markAllRead("u1");
    expect(result.updated).toBe(0);
  });

  it("returns correct updated count", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { markAllRead } = await import("../app/src/modules/notifications/notifications.service");

    (prisma.notification.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 5 });

    const result = await markAllRead("u1");
    expect(result.updated).toBe(5);
  });
});
