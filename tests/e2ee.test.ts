/** DM E2EE layer (addendum §5, §7): franking signing + storage endpoints. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    userMasterKeyWrap: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    userDevice: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    directMessage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    messageEnvelope: { createMany: vi.fn() },
    messageKeyEnvelope: { createMany: vi.fn() },
    userBlock: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const { prisma } = await import("../app/src/config/prisma");
      return fn(prisma);
    }),
  },
}));
vi.mock("../app/src/realtime/io-instance", () => ({ getIo: () => null }));
vi.mock("../app/src/realtime/presence", () => ({ isOnline: () => false, isViewing: () => false }));
vi.mock("../app/src/lib/push", () => ({ pushToUser: vi.fn() }));
const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

describe("franking (§5)", () => {
  it("server frank recomputes deterministically and rejects forgery", async () => {
    const { computeServerFrank, verifyServerFrank } = await import("../app/src/lib/franking");
    const args = { frankingTag: "tag123", messageId: "m1", senderId: "s1", ts: 1000 };
    const sf = computeServerFrank(args);
    expect(verifyServerFrank({ ...args, serverFrank: sf })).toBe(true);
    expect(verifyServerFrank({ ...args, serverFrank: sf, messageId: "m2" })).toBe(false); // tampered
    expect(verifyServerFrank({ ...args, serverFrank: "AAAA" })).toBe(false);
  });
});

describe("e2ee setup/state (§7) — server stores only wrapped material", () => {
  it("setup stores UMK wraps + first device; rejects double setup", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { setupE2EE } = await import("../app/src/modules/e2ee/e2ee.service");
    fn(prisma.userMasterKeyWrap.count).mockResolvedValue(0);
    fn(prisma.userMasterKeyWrap.createMany).mockResolvedValue({ count: 2 });
    fn(prisma.userDevice.create).mockResolvedValue({ id: "d1", name: "iPhone", createdAt: new Date() });
    const res = await setupE2EE("u1", {
      wraps: [
        { method: "PASSKEY_PRF", credentialId: "c1", wrappedUMK: "w", wrapIv: "iv", label: "iPhone passkey" },
        { method: "RECOVERY_CODE", wrappedUMK: "w2", wrapIv: "iv2", kdfSalt: "salt", label: "Recovery code" },
      ],
      device: { publicKey: "pub", wrappedPrivKey: "wpk", wrapIv: "div", name: "iPhone" },
    });
    expect(res.device.id).toBe("d1");
    expect(fn(prisma.userMasterKeyWrap.createMany).mock.calls[0][0].data).toHaveLength(2);

    fn(prisma.userMasterKeyWrap.count).mockResolvedValue(1); // already set up
    await expect(setupE2EE("u1", { wraps: [{ method: "PASSKEY_PRF", wrappedUMK: "w", wrapIv: "iv" }], device: { publicKey: "p", wrappedPrivKey: "w", wrapIv: "i", name: "x" } }))
      .rejects.toThrow("already set up");
  });

  it("cannot remove the last unlock method", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { removeWrap } = await import("../app/src/modules/e2ee/e2ee.service");
    fn(prisma.userMasterKeyWrap.findUnique).mockResolvedValue({ userId: "u1" });
    fn(prisma.userMasterKeyWrap.count).mockResolvedValue(1);
    await expect(removeWrap("u1", "wrap1")).rejects.toThrow("last unlock method");
  });

  it("conversation-devices enforces membership (IDOR→404)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getConversationDevices } = await import("../app/src/modules/e2ee/e2ee.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({ participant1: "a", participant2: "b" });
    await expect(getConversationDevices("intruder", "c1")).rejects.toThrow("Conversation not found");
  });

  it("E2EE send stores ciphertext + serverFrank + envelopes, body stays null", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { sendMessage } = await import("../app/src/modules/chat/chat.service");
    fn(prisma.conversation.findUnique).mockResolvedValue({
      id: "c1", participant1: "aaa", participant2: "zzz", status: "ACTIVE", initiatorId: "aaa", p1MutedUntil: null, p2MutedUntil: null,
    });
    fn(prisma.directMessage.create).mockResolvedValue({ id: "m1", conversationId: "c1", senderId: "aaa", type: "TEXT", body: null, createdAt: new Date(1000), readAt: null });
    fn(prisma.conversation.update).mockResolvedValue({});
    fn(prisma.directMessage.update).mockResolvedValue({});
    fn(prisma.messageEnvelope.createMany).mockResolvedValue({ count: 2 });
    await sendMessage({
      conversationId: "c1", senderId: "aaa", type: "TEXT",
      e2ee: {
        ciphertext: "CT", contentIv: "IV", frankingTag: "TAG",
        envelopes: [
          { deviceId: "d1", ephemeralPub: "e", wrappedCK: "w", wrapIv: "i" },
          { deviceId: "d2", ephemeralPub: "e", wrappedCK: "w", wrapIv: "i" },
        ],
      },
    });
    const created = fn(prisma.directMessage.create).mock.calls[0][0].data;
    expect(created.isE2EE).toBe(true);
    expect(created.ciphertext).toBe("CT");
    expect(created.body).toBeUndefined(); // never set plaintext for E2EE
    expect(fn(prisma.directMessage.update).mock.calls[0][0].data.serverFrank).toBeTruthy(); // counter-signed
    expect(fn(prisma.messageEnvelope.createMany).mock.calls[0][0].data).toHaveLength(2);
  });

  it("envelope heal only accepts the caller's own devices", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { healEnvelopes } = await import("../app/src/modules/e2ee/e2ee.service");
    fn(prisma.userDevice.findMany).mockResolvedValue([{ id: "mine" }]);
    fn(prisma.messageEnvelope.createMany).mockResolvedValue({ count: 1 });
    const res = await healEnvelopes("u1", [
      { messageId: "m1", deviceId: "mine", ephemeralPub: "e", wrappedCK: "w", wrapIv: "i" },
      { messageId: "m1", deviceId: "someone-else", ephemeralPub: "e", wrappedCK: "w", wrapIv: "i" },
    ]);
    expect(res.added).toBe(1); // only the owned device
  });
});

describe("franking report flow (§5)", () => {
  it("marks submitted evidence verified only when HMAC + serverFrank match", async () => {
    vi.resetModules()
    const { createHmac } = await import("node:crypto")
    const { computeServerFrank } = await import("../app/src/lib/franking")
    const frankingKeyB64 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
    const plaintext = "this is the abusive message"
    const frankingTag = createHmac("sha256", Buffer.from(frankingKeyB64, "base64")).update(plaintext).digest("base64")
    const ts = 1717000000000
    const serverFrank = computeServerFrank({ frankingTag, messageId: "m1", senderId: "them", ts })

    vi.doMock("../app/src/config/prisma", () => ({
      prisma: {
        conversation: { findUnique: vi.fn().mockResolvedValue({ id: "c1", participant1: "me", participant2: "them" }) },
        directMessage: { findMany: vi.fn().mockResolvedValue([
          { id: "m1", senderId: "them", type: "TEXT", body: null, mediaUrl: null, createdAt: new Date(ts), deletedAt: null, frankingTag, serverFrank, isE2EE: true },
        ]) },
        messageReport: { create: vi.fn(async (a: any) => ({ id: "r1", status: "open", createdAt: new Date(), _data: a.data })) },
      },
    }))
    const { reportConversation } = await import("../app/src/modules/safety/safety.service")

    // correct evidence → verified
    await reportConversation("me", { conversationId: "c1", reason: "harassment", evidence: [{ messageId: "m1", plaintext, frankingKey: frankingKeyB64 }] })
    const p1 = await import("../app/src/config/prisma")
    let snap = JSON.parse((p1.prisma.messageReport.create as any).mock.calls[0][0].data.details)
    expect(snap.messages[0].verification).toBe("verified")
    expect(snap.messages[0].decrypted).toBe(plaintext)

    // tampered plaintext → unverified
    await reportConversation("me", { conversationId: "c1", reason: "harassment", evidence: [{ messageId: "m1", plaintext: plaintext + "X", frankingKey: frankingKeyB64 }] })
    snap = JSON.parse((p1.prisma.messageReport.create as any).mock.calls[1][0].data.details)
    expect(snap.messages[0].verification).toBe("unverified")
    vi.doUnmock("../app/src/config/prisma")
    vi.resetModules()
  })
})
