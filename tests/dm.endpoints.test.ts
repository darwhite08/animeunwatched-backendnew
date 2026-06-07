/**
 * DM v2 endpoint/integration tests (spec §10):
 *  - per-user rate limit triggers 429 (new-conversation limit)
 *  - IDOR attempts on conversation-scoped reads return 404 (no existence leak)
 *  - block + report flows
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userBlock: { count: vi.fn().mockResolvedValue(0), upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    conversation: { findUnique: vi.fn() },
    directMessage: { findMany: vi.fn(), create: vi.fn() },
    messageReport: { create: vi.fn() },
  },
}));
vi.mock("../app/src/realtime/io-instance", () => ({ getIo: () => null }));
vi.mock("../app/src/realtime/presence", () => ({ isOnline: () => false, isViewing: () => false }));
vi.mock("../app/src/lib/push", () => ({ pushToUser: vi.fn() }));

const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
function ctx(over: Partial<Request> = {}, userId = "u1") {
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  const set = vi.fn();
  const send = vi.fn();
  const res = { status, json, set, send, locals: { user: { id: userId } } } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req: { params: {}, query: {}, body: {}, ip: "1.2.3.4", ...over } as Request, res, next, json, status, send };
}

beforeEach(() => vi.clearAllMocks());

describe("rate limit — new conversations (per user)", () => {
  it("returns 429 after the hourly cap is exceeded", async () => {
    const { rateLimit } = await import("../app/src/middlewares/rateLimit.middleware");
    const mw = rateLimit(5, 60 * 60_000, { perUser: true, bucket: "test-newconv" });
    let passed = 0; let limited = false;
    for (let i = 0; i < 7; i++) {
      const { req, res, next, status } = ctx();
      mw(req, res, next);
      if (fn(status).mock.calls.length) limited = true;
      else passed++;
    }
    expect(passed).toBe(5);
    expect(limited).toBe(true);
  });

  it("keys buckets per user (user B unaffected by user A hitting the cap)", async () => {
    const { rateLimit } = await import("../app/src/middlewares/rateLimit.middleware");
    const mw = rateLimit(2, 60_000, { perUser: true, bucket: "test-peruser" });
    for (let i = 0; i < 3; i++) { const c = ctx({}, "userA"); mw(c.req, c.res, c.next); }
    const b = ctx({}, "userB");
    mw(b.req, b.res, b.next);
    expect(fn(b.status).mock.calls.length).toBe(0); // B not limited
    expect(fn(b.next).mock.calls.length).toBe(1);
  });
});

describe("IDOR — conversation reads return 404 for non-participants", () => {
  it("getMessages throws NOT_FOUND when caller is not a participant", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getMessages } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "bbb", p1DeletedAt: null, p2DeletedAt: null });
    await expect(getMessages({ conversationId: "c1", userId: "intruder", limit: 30 }))
      .rejects.toThrow("Conversation not found");
  });

  it("searchConversation throws NOT_FOUND for non-participants", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { searchConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "bbb", p1DeletedAt: null, p2DeletedAt: null });
    await expect(searchConversation("intruder", "c1", "hi")).rejects.toThrow("Conversation not found");
  });
});

describe("safety — block + report", () => {
  it("blockUser upserts a UserBlock", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { blockUser } = await import("../app/src/modules/safety/safety.controller");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "target" });
    const { req, res, next, status, json } = ctx({ params: { id: "target" } }, "me");
    await blockUser(req, res, next);
    expect(fn(prisma.userBlock.upsert)).toHaveBeenCalledWith(expect.objectContaining({
      where: { blockerId_blockedId: { blockerId: "me", blockedId: "target" } },
    }));
    expect(fn(status)).toHaveBeenCalledWith(201);
    void json;
  });

  it("report stores an immutable 50-message snapshot", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { report } = await import("../app/src/modules/safety/safety.controller");
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "me", participant2: "them" });
    fn(prisma.directMessage.findMany).mockResolvedValue([
      { id: "m1", senderId: "them", type: "TEXT", body: "hi", mediaUrl: null, createdAt: new Date(), deletedAt: null },
    ]);
    fn(prisma.messageReport.create).mockResolvedValue({ id: "r1", status: "open", createdAt: new Date() });
    const { req, res, next } = ctx({ body: { conversationId: "c1", reason: "harassment", details: "abuse" } }, "me");
    await report(req, res, next);
    const createArg = fn(prisma.messageReport.create).mock.calls[0][0];
    expect(createArg.data.reportedUserId).toBe("them");
    expect(typeof createArg.data.details).toBe("string");
    expect(JSON.parse(createArg.data.details).messages).toHaveLength(1); // snapshot present
    expect(fn(prisma.directMessage.findMany).mock.calls[0][0].take).toBe(50);
  });

  it("report on a conversation the user isn't in → 404 (no leak)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { reportConversation } = await import("../app/src/modules/safety/safety.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "bbb" });
    await expect(reportConversation("intruder", { conversationId: "c1", reason: "spam" }))
      .rejects.toThrow("Conversation not found");
  });
});
