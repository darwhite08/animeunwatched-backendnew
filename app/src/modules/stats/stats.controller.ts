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

    const [totalUsers, signupGroups, androidRow, iosRow, nativeAndroid, nativeIos, deviceAndroid] = await Promise.all([
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
    ]);

    const signupPlatform: Record<string, number> = {};
    for (const g of signupGroups) signupPlatform[g.signupPlatform ?? "null"] = g._count._all;

    res.status(200).json({
      totalUsers,
      androidUsers: Number(androidRow[0]?.count ?? 0),   // distinct users w/ an Android push token
      iosUsers: Number(iosRow[0]?.count ?? 0),           // distinct users w/ an iOS push token
      signupPlatform,                                    // web | mobile | unknown split (signup attribution)
      pushTokens: { nativeAndroid, nativeIos, deviceAndroid }, // raw token counts (may exceed user counts)
    });
  } catch (err) { next(err); }
}
