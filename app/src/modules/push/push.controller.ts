import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./push.service";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { pushToUser } from "../../lib/push";
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
  registerNativeTokenSchema,
  unregisterNativeTokenSchema,
  webPushSubscribeSchema,
  webPushUnsubscribeSchema,
} from "./push.schema";

function verifyCronSecret(req: Request): boolean {
  const secret = req.headers["x-cron-secret"] ?? req.query.secret;
  return !!env.CRON_SECRET && secret === env.CRON_SECRET;
}

const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.kaiveron.app";

/**
 * POST /push/campaign — CRON_SECRET-gated broadcast push.
 * Body: { target: "email" | "android", email?, title?, body?, link?, dryRun? }
 * Sends across each targeted user's web-push + native endpoints (pushToUser).
 * Defaults to the "app is on Google Play" promo.
 */
export async function campaign(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const b = (req.body ?? {}) as { target?: string; email?: string; title?: string; body?: string; link?: string; dryRun?: boolean | string };

    const title = b.title || "Kaiveron is on Google Play 📲";
    const body  = b.body  || "The app is live! Download Kaiveron on the Play Store for the full experience — tap to get it.";
    const link  = b.link  || PLAY_STORE_URL;
    const dryRun = b.dryRun === true || b.dryRun === "true";

    let userIds: string[] = [];
    if (b.target === "email") {
      if (!b.email) { res.status(400).json({ error: "email required for target=email" }); return; }
      const u = await prisma.user.findFirst({ where: { email: { equals: b.email, mode: "insensitive" } }, select: { id: true } });
      userIds = u ? [u.id] : [];
    } else if (b.target === "android") {
      const rows = await prisma.$queryRaw<{ userId: string }[]>`
        SELECT DISTINCT "userId" FROM (
          SELECT "userId" FROM "RefreshToken"        WHERE "userAgent" ILIKE '%android%'
          UNION SELECT "userId" FROM "SecurityEvent" WHERE "userAgent" ILIKE '%android%' AND "userId" IS NOT NULL
          UNION SELECT "userId" FROM "WebPushSubscription" WHERE "userAgent" ILIKE '%android%'
        ) t`;
      userIds = rows.map((r) => r.userId);
    } else {
      res.status(400).json({ error: "target must be 'email' or 'android'" });
      return;
    }

    if (dryRun) { res.status(200).json({ dryRun: true, target: b.target, targetedUsers: userIds.length, title, body, link }); return; }

    let usersReached = 0;
    let endpointsSent = 0;
    for (let i = 0; i < userIds.length; i += 20) {
      const chunk = userIds.slice(i, i + 20);
      const counts = await Promise.all(
        chunk.map((id) => pushToUser(id, { title, body, data: { link, type: "announcement" } }).catch(() => 0)),
      );
      for (const c of counts) { if (c > 0) usersReached++; endpointsSent += c; }
    }

    res.status(200).json({ dryRun: false, target: b.target, title, body, link, targetedUsers: userIds.length, usersReached, endpointsSent });
  } catch (err) { next(err); }
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = registerDeviceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid device payload");
    const result = await service.registerDevice({ userId, ...parsed.data });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function unregister(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = unregisterDeviceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid token payload");
    await service.unregisterDevice({ userId, expoToken: parsed.data.expoToken });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─── Native (Capacitor FCM/APNs) ────────────────────────────────────────────────
export async function registerNative(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = registerNativeTokenSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid native token payload");
    const result = await service.registerNativeToken({ userId, ...parsed.data });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function unregisterNative(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = unregisterNativeTokenSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid native token payload");
    await service.unregisterNativeToken({ userId, token: parsed.data.token });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.listMyDevices(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function test(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.sendTestPush(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function webSubscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = webPushSubscribeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid web push subscription");
    const { subscription, userAgent } = parsed.data;
    await service.saveWebSubscription({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function webUnsubscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = webPushUnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid endpoint");
    await service.removeWebSubscription({ userId, endpoint: parsed.data.endpoint });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
