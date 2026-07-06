import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";

function verifyCronSecret(req: Request): boolean {
  const secret = req.headers["x-cron-secret"] ?? req.query.secret;
  return !!env.CRON_SECRET && secret === env.CRON_SECRET;
}

/**
 * GET /stats/platforms — CRON_SECRET-gated. Platform breakdown of users.
 *
 * signupPlatform only records web|mobile|unknown, so true Android/iOS counts
 * come from native push tokens: distinct users holding an android/ios token
 * across NativePushToken (Capacitor FCM/APNs) and DeviceToken (Expo).
 */
export async function platforms(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) { res.status(401).json({ error: "Unauthorized" }); return; }

    const [totalUsers, signupGroups, androidTokRow, iosTokRow, nativeAndroid, nativeIos, deviceAndroid, uaAndroidRow, uaIosRow] = await Promise.all([
      prisma.user.count(),
      prisma.user.groupBy({ by: ["signupPlatform"], _count: { _all: true } }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM (
          SELECT "userId" FROM "NativePushToken" WHERE platform = 'android'
          UNION SELECT "userId" FROM "DeviceToken" WHERE platform = 'android'
        ) t`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM (
          SELECT "userId" FROM "NativePushToken" WHERE platform = 'ios'
          UNION SELECT "userId" FROM "DeviceToken" WHERE platform = 'ios'
        ) t`,
      prisma.nativePushToken.count({ where: { platform: "android" } }),
      prisma.nativePushToken.count({ where: { platform: "ios" } }),
      prisma.deviceToken.count({ where: { platform: "android" } }),
      // Distinct users who ever logged in from an Android device (native app OR
      // web/PWA), by user-agent across sessions + login events.
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM (
          SELECT "userId" FROM "RefreshToken"        WHERE "userAgent" ILIKE '%android%'
          UNION SELECT "userId" FROM "SecurityEvent" WHERE "userAgent" ILIKE '%android%' AND "userId" IS NOT NULL
          UNION SELECT "userId" FROM "WebPushSubscription" WHERE "userAgent" ILIKE '%android%'
        ) t`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM (
          SELECT "userId" FROM "RefreshToken"        WHERE ("userAgent" ILIKE '%iphone%' OR "userAgent" ILIKE '%ipad%')
          UNION SELECT "userId" FROM "SecurityEvent" WHERE ("userAgent" ILIKE '%iphone%' OR "userAgent" ILIKE '%ipad%') AND "userId" IS NOT NULL
          UNION SELECT "userId" FROM "WebPushSubscription" WHERE ("userAgent" ILIKE '%iphone%' OR "userAgent" ILIKE '%ipad%')
        ) t`,
    ]);

    const signupPlatform: Record<string, number> = {};
    for (const g of signupGroups) signupPlatform[g.signupPlatform ?? "null"] = g._count._all;

    res.status(200).json({
      totalUsers,
      // Primary answer: distinct users seen logging in from an Android device (UA-based).
      androidUsers: Number(uaAndroidRow[0]?.count ?? 0),
      iosUsers: Number(uaIosRow[0]?.count ?? 0),
      // Narrower: users who installed the native app (registered a push token).
      nativeAppUsers: { android: Number(androidTokRow[0]?.count ?? 0), ios: Number(iosTokRow[0]?.count ?? 0) },
      signupPlatform,                                    // web | mobile | unknown split (signup attribution)
      pushTokens: { nativeAndroid, nativeIos, deviceAndroid }, // raw token counts (may exceed user counts)
    });
  } catch (err) { next(err); }
}
