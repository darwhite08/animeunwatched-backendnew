/**
 * DM v2 realtime tests (spec §10 socket cases):
 *  - delivery receipts produced on (re)connect
 *  - focus suppresses the unread increment
 *  - typing/presence privacy gate (canSeeActivity): block + showOnlineStatus
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    userBlock: { count: vi.fn().mockResolvedValue(0) },
    follow: { count: vi.fn().mockResolvedValue(0) },
    user: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    directMessage: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    messageKeyEnvelope: { createMany: vi.fn() },
    $transaction: vi.fn(async (arg: unknown) => {
      const { prisma } = await import("../app/src/config/prisma");
      return typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]);
    }),
  },
}));
vi.mock("../app/src/realtime/io-instance", () => ({ getIo: () => null }));
vi.mock("../app/src/lib/push", () => ({ pushToUser: vi.fn() }));

const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

describe("canSeeActivity — block + presence privacy", () => {
  it("false when either user blocks the other", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { canSeeActivity } = await import("../app/src/realtime/activityGuard");
    fn(prisma.userBlock.count).mockResolvedValue(1);
    expect(await canSeeActivity("a", "b")).toBe(false);
  });

  it("false when target showOnlineStatus = nobody", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { canSeeActivity } = await import("../app/src/realtime/activityGuard");
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.user.findUnique).mockResolvedValue({ showOnlineStatus: "nobody", readReceiptsOn: true });
    expect(await canSeeActivity("a", "b")).toBe(false);
  });

  it("true when everyone; followers requires the viewer to follow the target", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { canSeeActivity } = await import("../app/src/realtime/activityGuard");
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.user.findUnique).mockResolvedValue({ showOnlineStatus: "everyone", readReceiptsOn: true });
    expect(await canSeeActivity("a", "b")).toBe(true);

    fn(prisma.user.findUnique).mockResolvedValue({ showOnlineStatus: "followers", readReceiptsOn: true });
    fn(prisma.follow.count).mockResolvedValue(0);
    expect(await canSeeActivity("a", "b")).toBe(false);
    fn(prisma.follow.count).mockResolvedValue(1);
    expect(await canSeeActivity("a", "b")).toBe(true);
  });
});

describe("deliverUndelivered — receipts on connect", () => {
  it("marks pending messages delivered and returns per-sender receipts", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deliverUndelivered } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findMany).mockResolvedValue([
      { id: "m1", senderId: "s1", conversationId: "c1" },
      { id: "m2", senderId: "s2", conversationId: "c2" },
    ]);
    fn(prisma.directMessage.updateMany).mockResolvedValue({ count: 2 });
    const receipts = await deliverUndelivered("me");
    expect(receipts).toHaveLength(2);
    expect(fn(prisma.directMessage.updateMany).mock.calls[0][0].data).toHaveProperty("deliveredAt");
  });

  it("no-ops when nothing is pending", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deliverUndelivered } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findMany).mockResolvedValue([]);
    expect(await deliverUndelivered("me")).toEqual([]);
    expect(fn(prisma.directMessage.updateMany)).not.toHaveBeenCalled();
  });
});

describe("focus suppresses unread increment", () => {
  it("does NOT increment recipient unread when they are viewing the conversation", async () => {
    vi.doMock("../app/src/realtime/presence", () => ({ isOnline: () => true, isViewing: () => true }));
    vi.resetModules();
    const { prisma } = await import("../app/src/config/prisma");
    fn(prisma.conversation.findUnique).mockResolvedValue({
      id: "c1", participant1: "aaa", participant2: "zzz", status: "ACTIVE", initiatorId: "aaa", p1MutedUntil: null, p2MutedUntil: null,
    });
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.directMessage.create).mockResolvedValue({ id: "m1", conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi", createdAt: new Date(), readAt: null });
    fn(prisma.conversation.update).mockResolvedValue({});
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    await sendMessage({ conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi" }); // recipient zzz is viewing
    const updateData = fn(prisma.conversation.update).mock.calls[0][0].data;
    expect(updateData.p2UnreadCount).toBeUndefined(); // no increment while focused
    vi.doUnmock("../app/src/realtime/presence");
    vi.resetModules();
  });
});
