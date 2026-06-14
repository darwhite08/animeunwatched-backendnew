import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./push.service";
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
  registerNativeTokenSchema,
  unregisterNativeTokenSchema,
  webPushSubscribeSchema,
  webPushUnsubscribeSchema,
} from "./push.schema";

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
