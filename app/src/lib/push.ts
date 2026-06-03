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
// ─── Native FCM (Capacitor Android/iOS) ─────────────────────────────────────────
// Lazy-initialized from FIREBASE_SERVICE_ACCOUNT (JSON string). If unset, all
// FCM sends are no-ops — the rest of push keeps working. Set that env var +
// drop google-services.json in the app to activate delivery.
let fcmTried = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fcmApp: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getFcmApp(): Promise<any | null> {
  if (fcmTried) return fcmApp;
  fcmTried = true;
  const creds = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!creds) return null;
  try {
    const admin = await import("firebase-admin");
    const sa = JSON.parse(creds);
    fcmApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
    return fcmApp;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[push] firebase-admin init failed", err);
    return null;
  }
}

export async function sendFcmPush(
  tokens: string[],
  notif: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  if (tokens.length === 0) return;
  const app = await getFcmApp();
  if (!app) return; // not configured — no-op
  const admin = await import("firebase-admin");
  const data = Object.fromEntries(
    Object.entries(notif.data ?? {}).map(([k, v]) => [k, String(v)]),
  );
  try {
    const res = await admin.messaging(app).sendEachForMulticast({
      tokens,
      notification: { title: notif.title, body: notif.body },
      data,
    });
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code ?? "";
      if (!r.success && (code.includes("registration-token-not-registered") || code.includes("invalid-argument"))) {
        const t = tokens[i];
        if (t) dead.push(t);
      }
    });
    if (dead.length > 0) await prisma.nativePushToken.deleteMany({ where: { token: { in: dead } } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[push] FCM send failed", err);
  }
}

export async function pushToUser(
  userId: string,
  notif: { title: string; body: string; data?: Record<string, unknown> },
): Promise<number> {
  const [devices, native] = await Promise.all([
    prisma.deviceToken.findMany({ where: { userId }, select: { expoToken: true } }),
    prisma.nativePushToken.findMany({ where: { userId }, select: { token: true } }),
  ]);
  if (devices.length > 0) {
    await sendExpoPush({
      tokens: devices.map((d) => d.expoToken),
      title: notif.title,
      body: notif.body,
      data: notif.data,
    });
  }
  if (native.length > 0) await sendFcmPush(native.map((d) => d.token), notif);
  return devices.length + native.length;
}
