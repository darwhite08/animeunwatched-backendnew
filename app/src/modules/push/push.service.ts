import { prisma } from "../../config/prisma";
import { pushToUser } from "../../lib/push";

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

// ─── Native (Capacitor FCM/APNs) tokens ─────────────────────────────────────────
export async function registerNativeToken(opts: {
  userId: string;
  token: string;
  platform: "ios" | "android";
}) {
  // Token is unique across users — transfer to the latest owner (shared device).
  const device = await prisma.nativePushToken.upsert({
    where:  { token: opts.token },
    create: { userId: opts.userId, token: opts.token, platform: opts.platform },
    update: { userId: opts.userId, platform: opts.platform, lastSeenAt: new Date() },
  });
  return { device };
}

export async function unregisterNativeToken(opts: { userId: string; token: string }) {
  await prisma.nativePushToken.deleteMany({ where: { token: opts.token, userId: opts.userId } });
  return { ok: true };
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
  // Route through pushToUser so the test reaches EVERY channel the user has —
  // Expo, native FCM, AND web push — not just Expo tokens.
  const sent = await pushToUser(userId, {
    title: "Kaiveron test push",
    body: "If you can see this, push notifications are working 🎉",
    data: { type: "test", link: "/" },
  });
  return { sent };
}

// ─── Web Push (VAPID) subscriptions ───────────────────────────────────────────
export async function saveWebSubscription(opts: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}) {
  // Endpoint is unique per browser/device — upsert so re-subscribing (or a new
  // owner on a shared device) updates rather than duplicates.
  await prisma.webPushSubscription.upsert({
    where: { endpoint: opts.endpoint },
    create: {
      userId: opts.userId,
      endpoint: opts.endpoint,
      p256dh: opts.p256dh,
      auth: opts.auth,
      userAgent: opts.userAgent ?? null,
    },
    update: { userId: opts.userId, p256dh: opts.p256dh, auth: opts.auth, lastSeen: new Date() },
  });
  return { ok: true };
}

export async function removeWebSubscription(opts: { userId: string; endpoint: string }) {
  await prisma.webPushSubscription.deleteMany({ where: { endpoint: opts.endpoint, userId: opts.userId } });
  return { ok: true };
}
