/**
 * Expo Push helper. Wraps `expo-server-sdk` so notify.ts and the push module
 * don't have to know about chunking, receipts, or token validation.
 *
 * Tokens that come back as "DeviceNotRegistered" from Expo are pruned from
 * the DB so we don't keep sending to dead devices.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../config/prisma";

const expo = new Expo({
  // EXPO_ACCESS_TOKEN is only required for Production push security mode.
  // Without it, Expo's free tier still works.
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

export type PushPayload = {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
  channelId?: string;
};

export async function sendExpoPush(payload: PushPayload): Promise<void> {
  const valid = payload.tokens.filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) return;

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    sound: "default",
    badge: payload.badge,
    channelId: payload.channelId ?? "default",
    priority: "high",
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const t = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...t);
    } catch (err) {
      // Don't let a downstream push failure break the calling request.
      // Log and continue — push is best-effort by design.
      // eslint-disable-next-line no-console
      console.error("[push] send chunk failed", err);
    }
  }

  // Prune tokens Expo rejected as unregistered. This keeps the DB clean.
  const dead: string[] = [];
  tickets.forEach((ticket, idx) => {
    if (ticket.status === "error") {
      const code = ticket.details?.error;
      if (code === "DeviceNotRegistered") {
        const token = messages[idx]?.to;
        if (typeof token === "string") dead.push(token);
      }
    }
  });
  if (dead.length > 0) {
    await prisma.deviceToken.deleteMany({ where: { expoToken: { in: dead } } });
  }
}

/**
 * Fetch all push tokens for a user, then dispatch.
 * Returns the count actually targeted.
 */
export async function pushToUser(
  userId: string,
  notif: { title: string; body: string; data?: Record<string, unknown> },
): Promise<number> {
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
    select: { expoToken: true },
  });
  if (devices.length === 0) return 0;
  await sendExpoPush({
    tokens: devices.map((d) => d.expoToken),
    title: notif.title,
    body: notif.body,
    data: notif.data,
  });
  return devices.length;
}
