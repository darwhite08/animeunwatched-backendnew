import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./push.service";
import { registerDeviceSchema, unregisterDeviceSchema } from "./push.schema";

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
