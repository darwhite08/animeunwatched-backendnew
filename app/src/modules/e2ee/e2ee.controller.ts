import { Request, Response, NextFunction } from "express";
import * as e2ee from "./e2ee.service";
import { setupSchema, addDeviceSchema, addWrapSchema, healSchema } from "./e2ee.schema";

const uid = (res: Response) => res.locals.user.id as string;

export async function setup(req: Request, res: Response, next: NextFunction) {
  try { const { body } = setupSchema.parse({ body: req.body }); res.status(201).json(await e2ee.setupE2EE(uid(res), body)); }
  catch (err) { next(err); }
}
export async function state(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await e2ee.getState(uid(res))); } catch (err) { next(err); }
}
export async function addDevice(req: Request, res: Response, next: NextFunction) {
  try { const { body } = addDeviceSchema.parse({ body: req.body }); res.status(201).json({ device: await e2ee.addDevice(uid(res), body) }); }
  catch (err) { next(err); }
}
export async function listDevices(_req: Request, res: Response, next: NextFunction) {
  try { res.json({ devices: await e2ee.listDevices(uid(res)) }); } catch (err) { next(err); }
}
export async function revokeDevice(req: Request, res: Response, next: NextFunction) {
  try { res.json(await e2ee.revokeDevice(uid(res), req.params.id as string)); } catch (err) { next(err); }
}
export async function addWrap(req: Request, res: Response, next: NextFunction) {
  try { const { body } = addWrapSchema.parse({ body: req.body }); res.status(201).json({ wrap: await e2ee.addWrap(uid(res), body) }); }
  catch (err) { next(err); }
}
export async function removeWrap(req: Request, res: Response, next: NextFunction) {
  try { res.json(await e2ee.removeWrap(uid(res), req.params.id as string)); } catch (err) { next(err); }
}
export async function conversationDevices(req: Request, res: Response, next: NextFunction) {
  try { res.json(await e2ee.getConversationDevices(uid(res), req.params.id as string)); } catch (err) { next(err); }
}
export async function heal(req: Request, res: Response, next: NextFunction) {
  try { const { body } = healSchema.parse({ body: req.body }); res.json(await e2ee.healEnvelopes(uid(res), body.items)); }
  catch (err) { next(err); }
}
