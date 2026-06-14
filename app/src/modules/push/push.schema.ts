import { z } from "zod";

export const registerDeviceSchema = z.object({
  expoToken: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (t) => t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["),
      "Invalid Expo push token format",
    ),
  platform: z.enum(["ios", "android", "web"]),
  deviceName: z.string().max(120).optional(),
});

export const unregisterDeviceSchema = z.object({
  expoToken: z.string().min(1).max(200),
});

// Native (Capacitor FCM/APNs) token registration.
export const registerNativeTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ios", "android"]),
});

export const unregisterNativeTokenSchema = z.object({
  token: z.string().min(1).max(4096),
});

// W3C Web Push (VAPID) subscription from the browser's PushManager.
export const webPushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(100),
    }),
  }),
  userAgent: z.string().max(500).optional(),
});

export const webPushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
});
