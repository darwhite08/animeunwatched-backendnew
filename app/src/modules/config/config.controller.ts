import { Request, Response, NextFunction } from "express";
import * as service from "./config.service";
import { broadcastFlagsChanged } from "../../realtime/broadcast";
import { getInviteOnly } from "../../lib/inviteGate";

/** GET /config/signup — public signup config (is the invite-only gate on?). */
export async function getSignupConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.set("Cache-Control", "public, max-age=10");
    res.status(200).json({ inviteOnly: await getInviteOnly() });
  } catch (err) { next(err); }
}

export async function listFlagsAdmin(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ flags: await service.listClientFlagsAdmin() });
  } catch (err) { next(err); }
}

export async function setFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.params.key as string;
    const enabled = req.body?.enabled !== false;
    const result = await service.setClientFlag(key, enabled);
    broadcastFlagsChanged(key);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

/** GET /config/flags — client feature-flag map for the caller (optionalAuth). */
export async function getFlags(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string | undefined;
    const flags = await service.getClientFlags(userId);
    // Short cache; realtime `flags.updated` socket event drives instant refresh.
    res.set("Cache-Control", "public, max-age=15");
    res.status(200).json({ flags });
  } catch (err) {
    next(err);
  }
}
