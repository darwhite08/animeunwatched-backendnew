import { prisma } from "../../config/prisma";
import { sendExpoPush } from "../../lib/push";

export async function registerDevice(opts: {
  userId: string;
  expoToken: string;
  platform: "ios" | "android" | "web";
  deviceName?: string;
}) {
  // Tokens are unique across users — if seen, transfer to the new owner.
  // This handles the "shared device, different user logs in" case correctly.
  const existing = await prisma.deviceToken.findUnique({
    where: { expoToken: opts.expoToken },
  });

  if (existing) {
    const updated = await prisma.deviceToken.update({
      where: { expoToken: opts.expoToken },
      data: {
        userId: opts.userId,
        platform: opts.platform,
        deviceName: opts.deviceName ?? existing.deviceName,
        lastSeenAt: new Date(),
      },
    });
    return { device: updated };
  }

  const created = await prisma.deviceToken.create({
    data: {
      userId: opts.userId,
      expoToken: opts.expoToken,
      platform: opts.platform,
      deviceName: opts.deviceName,
    },
  });
  return { device: created };
}

export async function unregisterDevice(opts: { userId: string; expoToken: string }) {
  // Only allow deletion of tokens owned by this user — silently no-op otherwise
  // so we don't reveal whether a token exists for another account.
  await prisma.deviceToken.deleteMany({
    where: { expoToken: opts.expoToken, userId: opts.userId },
  });
  return { ok: true };
}

export async function listMyDevices(userId: string) {
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      platform: true,
      deviceName: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  return { devices };
}

export async function sendTestPush(userId: string) {
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
    select: { expoToken: true },
  });
  const tokens = devices.map((d) => d.expoToken);
  if (tokens.length === 0) return { sent: 0 };
  await sendExpoPush({
    tokens,
    title: "Kaiveron test push",
    body: "If you can see this, push notifications are working 🎉",
    data: { type: "test" },
  });
  return { sent: tokens.length };
}
