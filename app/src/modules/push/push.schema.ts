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
