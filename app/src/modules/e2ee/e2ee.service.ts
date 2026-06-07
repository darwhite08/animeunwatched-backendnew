import { prisma } from "../../config/prisma";
import { notFound, forbidden, badReq } from "../../lib/errors";

// The server NEVER performs crypto here — it only stores public keys, wrapped
// key material, and envelopes. All wrapping/unwrapping happens on the client.

type UmkWrapInput = {
  method: "PASSKEY_PRF" | "RECOVERY_CODE" | "FALLBACK_PASSPHRASE";
  credentialId?: string;
  wrappedUMK: string;
  wrapIv: string;
  kdfSalt?: string;
  kdfParams?: unknown;
  label?: string;
};
type DeviceInput = { publicKey: string; wrappedPrivKey: string; wrapIv: string; name: string };

/** First-time setup: store the UMK wraps (passkey + recovery, etc.) + first device. */
export async function setupE2EE(userId: string, dto: { wraps: UmkWrapInput[]; device: DeviceInput }) {
  if (!dto.wraps?.length) throw badReq("At least one key wrap is required");
  const existing = await prisma.userMasterKeyWrap.count({ where: { userId } });
  if (existing > 0) throw badReq("E2EE already set up — use add-wrap/add-device");

  const device = await prisma.$transaction(async (tx) => {
    await tx.userMasterKeyWrap.createMany({
      data: dto.wraps.map((w) => ({
        userId, method: w.method, credentialId: w.credentialId ?? null,
        wrappedUMK: w.wrappedUMK, wrapIv: w.wrapIv,
        kdfSalt: w.kdfSalt ?? null, kdfParams: (w.kdfParams as object) ?? undefined, label: w.label ?? null,
      })),
    });
    return tx.userDevice.create({
      data: { userId, publicKey: dto.device.publicKey, wrappedPrivKey: dto.device.wrappedPrivKey, wrapIv: dto.device.wrapIv, name: dto.device.name },
      select: { id: true, name: true, createdAt: true },
    });
  });
  return { ok: true, device };
}

export async function getState(userId: string) {
  const [wraps, devices] = await Promise.all([
    prisma.userMasterKeyWrap.findMany({
      where: { userId },
      select: { id: true, method: true, credentialId: true, label: true, lastUsedAt: true, createdAt: true, wrappedUMK: true, wrapIv: true, kdfSalt: true, kdfParams: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.userDevice.findMany({
      where: { userId },
      select: { id: true, name: true, publicKey: true, wrappedPrivKey: true, wrapIv: true, revoked: true, lastSeenAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { hasE2EE: wraps.length > 0, wraps, devices };
}

export async function addDevice(userId: string, dto: DeviceInput) {
  const device = await prisma.userDevice.create({
    data: { userId, publicKey: dto.publicKey, wrappedPrivKey: dto.wrappedPrivKey, wrapIv: dto.wrapIv, name: dto.name },
    select: { id: true, name: true, createdAt: true },
  });
  return device;
}

export async function listDevices(userId: string) {
  return prisma.userDevice.findMany({
    where: { userId },
    select: { id: true, name: true, revoked: true, lastSeenAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function revokeDevice(userId: string, deviceId: string) {
  const d = await prisma.userDevice.findUnique({ where: { id: deviceId }, select: { userId: true } });
  if (!d || d.userId !== userId) throw notFound("Device not found");
  await prisma.userDevice.update({ where: { id: deviceId }, data: { revoked: true } });
  return { ok: true };
}

export async function addWrap(userId: string, w: UmkWrapInput) {
  const wrap = await prisma.userMasterKeyWrap.create({
    data: {
      userId, method: w.method, credentialId: w.credentialId ?? null,
      wrappedUMK: w.wrappedUMK, wrapIv: w.wrapIv, kdfSalt: w.kdfSalt ?? null,
      kdfParams: (w.kdfParams as object) ?? undefined, label: w.label ?? null,
    },
    select: { id: true, method: true, label: true, createdAt: true },
  });
  return wrap;
}

export async function removeWrap(userId: string, wrapId: string) {
  const w = await prisma.userMasterKeyWrap.findUnique({ where: { id: wrapId }, select: { userId: true } });
  if (!w || w.userId !== userId) throw notFound("Wrap not found");
  const remaining = await prisma.userMasterKeyWrap.count({ where: { userId } });
  if (remaining <= 1) throw badReq("Cannot remove your last unlock method");
  await prisma.userMasterKeyWrap.delete({ where: { id: wrapId } });
  return { ok: true };
}

/** Active (non-revoked) devices of BOTH participants — envelope targets. */
export async function getConversationDevices(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participant1: true, participant2: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  const devices = await prisma.userDevice.findMany({
    where: { userId: { in: [conv.participant1, conv.participant2] }, revoked: false },
    select: { id: true, userId: true, publicKey: true },
  });
  return { devices };
}

/** Self-heal: add envelopes for the caller's own devices to messages that lacked one. */
export async function healEnvelopes(userId: string, items: { messageId: string; deviceId: string; ephemeralPub: string; wrappedCK: string; wrapIv: string }[]) {
  if (!items?.length) return { added: 0 };
  // Only allow healing into the caller's OWN devices, for messages in their conversations.
  const myDeviceIds = new Set((await prisma.userDevice.findMany({ where: { userId }, select: { id: true } })).map((d) => d.id));
  const valid = items.filter((i) => myDeviceIds.has(i.deviceId));
  if (!valid.length) throw forbidden("Envelopes must target your own devices");
  await prisma.messageEnvelope.createMany({
    data: valid.map((i) => ({ messageId: i.messageId, deviceId: i.deviceId, ephemeralPub: i.ephemeralPub, wrappedCK: i.wrappedCK, wrapIv: i.wrapIv })),
    skipDuplicates: true,
  });
  return { added: valid.length };
}
