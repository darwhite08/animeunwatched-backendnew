/** DM security checklist spot-checks (spec §9): block on reactions, generic errors. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    directMessage: { findUnique: vi.fn() },
    userBlock: { count: vi.fn() },
    messageReaction: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown) => Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : ops),
  },
}));
vi.mock("../app/src/realtime/io-instance", () => ({ getIo: () => null }));
vi.mock("../app/src/realtime/presence", () => ({ isOnline: () => false, isViewing: () => false }));
vi.mock("../app/src/lib/push", () => ({ pushToUser: vi.fn() }));
const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

describe("§9.2 block enforced on reactions (both directions)", () => {
  it("rejects a reaction with the generic message when blocked", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReaction } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findUnique).mockResolvedValue({
      conversationId: "c1", conversation: { participant1: "me", participant2: "them" },
    });
    fn(prisma.userBlock.count).mockResolvedValue(1);
    await expect(addReaction("me", "m1", "❤️")).rejects.toThrow("Unable to send message");
  });

  it("§9.1 reacting to a message in someone else's conversation → 404", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReaction } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.directMessage.findUnique).mockResolvedValue({
      conversationId: "c1", conversation: { participant1: "aaa", participant2: "bbb" },
    });
    await expect(addReaction("intruder", "m1", "❤️")).rejects.toThrow("Message not found");
  });
});
