// LOCKED CHARACTERIZATION TEST — pins current behavior of DM `getMessages`.
// To change behavior, unlock in .claude/LOCKED.md first. Do not weaken to pass.
//
// Why this is locked: getMessages once silently returned ZERO messages for every
// conversation because the disappearing-message filter used a null-unsafe
// `NOT: { expiresAt: { lt: now } }` (SQL three-valued logic drops rows where
// expiresAt IS NULL — i.e. all normal messages). These tests guarantee (a)
// messages are returned and (b) the expiry filter stays null-safe.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/src/config/prisma", () => ({
  prisma: {
    conversation: { findUnique: vi.fn() },
    userDeviceKey: { findMany: vi.fn() },
    directMessage: { findMany: vi.fn() },
  },
}));

const USER = "u_self";
const CONV = "c_1";

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, senderId: USER, type: "TEXT", body: `msg ${id}`,
    mediaUrl: null, mediaMime: null, mediaSizeBytes: null, mediaWidth: null,
    mediaHeight: null, mediaDurationS: null, mediaBlurhash: null,
    animeMalId: null, animeEpisode: null, replyToId: null, editedAt: null,
    ciphertext: null, iv: null, contentIv: null, isE2EE: false,
    createdAt: new Date("2026-06-08T00:00:00Z"), readAt: null, deliveredAt: null,
    deletedAt: null, senderDeviceKeyId: null, replyTo: null,
    envelopesV2: [], envelopes: [], reactions: [],
    ...over,
  };
}

async function setup() {
  const { prisma } = await import("../../app/src/config/prisma");
  const { getMessages } = await import("../../app/src/modules/chat/chat.service");
  (prisma.conversation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: CONV, participant1: USER, participant2: "u_other", p1DeletedAt: null, p2DeletedAt: null,
  });
  (prisma.userDeviceKey.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  return { prisma, getMessages };
}

describe("LOCKED: dm-getmessages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the conversation's messages (never silently empty)", async () => {
    const { prisma, getMessages } = await setup();
    (prisma.directMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row("m1"), row("m2")]);

    const res = await getMessages({ userId: USER, conversationId: CONV, limit: 30 });

    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({ id: "m1", body: "msg m1" });
    expect(Array.isArray(res.messages[0].reactions)).toBe(true);
  });

  it("filters disappearing messages NULL-SAFELY (regression guard)", async () => {
    const { prisma, getMessages } = await setup();
    (prisma.directMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await getMessages({ userId: USER, conversationId: CONV, limit: 30 });

    const where = (prisma.directMessage.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    const json = JSON.stringify(where);

    // The null-unsafe form that caused the outage must NOT be present.
    expect(json).not.toContain('"NOT":{"expiresAt"');
    // The null-safe branch (include rows whose expiresAt IS NULL) MUST be present.
    expect(json).toContain('"expiresAt":null');
  });

  it("404s on a conversation the user is not part of (IDOR guard)", async () => {
    const { prisma, getMessages } = await setup();
    (prisma.conversation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: CONV, participant1: "u_a", participant2: "u_b", p1DeletedAt: null, p2DeletedAt: null,
    });

    await expect(getMessages({ userId: USER, conversationId: CONV, limit: 30 })).rejects.toThrow();
  });
});
