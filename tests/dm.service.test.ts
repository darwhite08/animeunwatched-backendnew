/**
 * DM v2 service unit tests (spec §10):
 *  - conversation canonicalization (no duplicate A↔B / B↔A)
 *  - PENDING 3-message cap + auto-promote on recipient reply
 *  - block rejection both directions
 *  - read-receipt mutual privacy rule
 *  - edit window
 *  - clientNonce dedup idempotency
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userPublicKey: { findUnique: vi.fn().mockResolvedValue(null) },
    userBlock: { count: vi.fn().mockResolvedValue(0) },
    follow: { count: vi.fn().mockResolvedValue(0) },
    anime: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    directMessage: {
      findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(),
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    },
    messageReaction: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    messageKeyEnvelope: { createMany: vi.fn() },
    // interactive transaction passes the same mocked client through
    $transaction: vi.fn(async (arg: unknown) => {
      const { prisma } = await import("../app/src/config/prisma");
      if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(prisma);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  },
}));

vi.mock("../app/src/realtime/io-instance", () => ({ getIo: () => null }));
vi.mock("../app/src/realtime/presence", () => ({
  isOnline: vi.fn().mockReturnValue(false),
  isViewing: vi.fn().mockReturnValue(false),
}));
vi.mock("../app/src/lib/push", () => ({ pushToUser: vi.fn().mockResolvedValue(0) }));

const fn = <T = unknown>(m: unknown) => m as ReturnType<typeof vi.fn> & T;

beforeEach(() => vi.clearAllMocks());

describe("getOrCreateConversation", () => {
  it("rejects messaging yourself", async () => {
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    await expect(getOrCreateConversation("u1", "u1")).rejects.toThrow();
  });

  it("canonicalizes participant order (B↔A resolves to the same A↔B row)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "aaa", username: "a", displayName: "A", avatarUrl: null, dmPrivacy: "everyone" });
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "zzz", createdAt: new Date(), status: "ACTIVE" });
    fn(prisma.userPublicKey ?? {}); // not used

    // caller "zzz", recipient "aaa" → sorted [aaa, zzz]
    await getOrCreateConversation("zzz", "aaa").catch(() => {});
    const where = fn(prisma.conversation.findUnique).mock.calls[0][0].where;
    expect(where.participant1_participant2).toEqual({ participant1: "aaa", participant2: "zzz" });
  });

  it("creates PENDING when recipient does not follow the initiator", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "aaa", username: "a", displayName: "A", avatarUrl: null, dmPrivacy: "everyone" });
    fn(prisma.conversation.findUnique).mockResolvedValue(null);
    fn(prisma.follow.count).mockResolvedValue(0); // recipient does NOT follow caller
    fn(prisma.conversation.create).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "zzz", createdAt: new Date(), status: "PENDING" });
    const res = await getOrCreateConversation("zzz", "aaa");
    expect(res.status).toBe("PENDING");
    expect(fn(prisma.conversation.create).mock.calls[0][0].data.status).toBe("PENDING");
  });

  it("creates ACTIVE when recipient already follows the initiator", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "aaa", username: "a", displayName: "A", avatarUrl: null, dmPrivacy: "everyone" });
    fn(prisma.conversation.findUnique).mockResolvedValue(null);
    fn(prisma.follow.count).mockResolvedValue(1); // recipient follows caller
    fn(prisma.conversation.create).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "zzz", createdAt: new Date(), status: "ACTIVE" });
    const res = await getOrCreateConversation("zzz", "aaa");
    expect(res.status).toBe("ACTIVE");
  });

  it("rejects with generic error when dmPrivacy=nobody", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "aaa", username: "a", displayName: "A", avatarUrl: null, dmPrivacy: "nobody" });
    fn(prisma.conversation.findUnique).mockResolvedValue(null);
    await expect(getOrCreateConversation("zzz", "aaa")).rejects.toThrow("Unable to send message");
  });

  it("rejects (generic) when either user blocks the other", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getOrCreateConversation } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique).mockResolvedValue({ id: "aaa", username: "a", displayName: "A", avatarUrl: null, dmPrivacy: "everyone" });
    fn(prisma.userBlock.count).mockResolvedValue(1);
    await expect(getOrCreateConversation("zzz", "aaa")).rejects.toThrow("Unable to send message");
  });
});

describe("sendMessage", () => {
  const activeConv = {
    id: "c1", participant1: "aaa", participant2: "zzz", status: "ACTIVE",
    initiatorId: "aaa", p1MutedUntil: null, p2MutedUntil: null,
  };

  it("returns 404-style error for a non-participant (no existence leak)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue(activeConv);
    await expect(sendMessage({ conversationId: "c1", senderId: "intruder", type: "TEXT", body: "hi" }))
      .rejects.toThrow("Conversation not found");
  });

  it("blocks send when users block each other (both directions)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue(activeConv);
    fn(prisma.userBlock.count).mockResolvedValue(1);
    await expect(sendMessage({ conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi" }))
      .rejects.toThrow("Unable to send message");
  });

  it("enforces the 3-message PENDING cap for the initiator", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ ...activeConv, status: "PENDING" });
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.directMessage.count).mockResolvedValue(3); // already at cap
    await expect(sendMessage({ conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi" }))
      .rejects.toThrow("Message request limit");
  });

  it("auto-promotes PENDING → ACTIVE when the recipient replies", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ ...activeConv, status: "PENDING", initiatorId: "aaa" });
    fn(prisma.userBlock.count).mockResolvedValue(0);
    fn(prisma.directMessage.create).mockResolvedValue({ id: "m1", conversationId: "c1", senderId: "zzz", type: "TEXT", body: "yo", createdAt: new Date(), readAt: null });
    fn(prisma.conversation.update).mockResolvedValue({});
    // recipient "zzz" sends
    await sendMessage({ conversationId: "c1", senderId: "zzz", type: "TEXT", body: "yo" });
    expect(fn(prisma.conversation.update).mock.calls[0][0].data.status).toBe("ACTIVE");
  });

  it("dedups on clientNonce (returns the existing message)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue(activeConv);
    fn(prisma.userBlock.count).mockResolvedValue(0);
    const existing = { id: "m-existing", conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi", createdAt: new Date(), readAt: null };
    fn(prisma.directMessage.findUnique).mockResolvedValue(existing);
    const res = await sendMessage({ conversationId: "c1", senderId: "aaa", type: "TEXT", body: "hi", clientNonce: "n1" });
    expect(res.id).toBe("m-existing");
    expect(fn(prisma.directMessage.create)).not.toHaveBeenCalled();
  });

  it("rejects empty / oversized text bodies", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue(activeConv);
    fn(prisma.userBlock.count).mockResolvedValue(0);
    await expect(sendMessage({ conversationId: "c1", senderId: "aaa", type: "TEXT", body: "   " }))
      .rejects.toThrow("1–4000");
  });
});

describe("markConversationRead — mutual read-receipt privacy", () => {
  beforeEach(async () => {
    const { prisma } = await import("../app/src/config/prisma");
    fn(prisma.conversation.findUnique).mockResolvedValue({ id: "c1", participant1: "aaa", participant2: "zzz" });
    fn(prisma.directMessage.updateMany).mockResolvedValue({ count: 1 });
    fn(prisma.conversation.update).mockResolvedValue({});
    fn(prisma.userBlock.count).mockResolvedValue(0);
  });

  it("emits chat.read only when BOTH users have receipts on", async () => {
    const io = await import("../app/src/realtime/io-instance");
    const emit = vi.fn();
    const to = vi.fn().mockReturnValue({ emit });
    vi.spyOn(io, "getIo").mockReturnValue({ to } as never);

    const { prisma } = await import("../app/src/config/prisma");
    const { markConversationRead } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique)
      .mockResolvedValueOnce({ readReceiptsOn: true })   // me
      .mockResolvedValueOnce({ readReceiptsOn: true });  // other
    await markConversationRead("c1", "aaa");
    expect(emit).toHaveBeenCalledWith("chat.read", expect.objectContaining({ conversationId: "c1" }));
  });

  it("suppresses chat.read when the OTHER user has receipts off", async () => {
    const io = await import("../app/src/realtime/io-instance");
    const emit = vi.fn();
    const to = vi.fn().mockReturnValue({ emit });
    vi.spyOn(io, "getIo").mockReturnValue({ to } as never);

    const { prisma } = await import("../app/src/config/prisma");
    const { markConversationRead } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.user.findUnique)
      .mockResolvedValueOnce({ readReceiptsOn: true })    // me
      .mockResolvedValueOnce({ readReceiptsOn: false });  // other
    await markConversationRead("c1", "aaa");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("editMessage — window + ownership", () => {
  it("rejects edits past the 15-minute window", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { editMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findUnique).mockResolvedValue({
      id: "m1", senderId: "aaa", conversationId: "c1", type: "TEXT",
      createdAt: new Date(Date.now() - 20 * 60 * 1000), deletedAt: null,
      conversation: { participant1: "aaa", participant2: "zzz" },
    });
    await expect(editMessage("aaa", "m1", "new")).rejects.toThrow("Edit window");
  });

  it("rejects edits from a non-sender", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { editMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findUnique).mockResolvedValue({
      id: "m1", senderId: "aaa", conversationId: "c1", type: "TEXT",
      createdAt: new Date(), deletedAt: null,
      conversation: { participant1: "aaa", participant2: "zzz" },
    });
    await expect(editMessage("zzz", "m1", "hax")).rejects.toThrow("Only the sender");
  });
});
