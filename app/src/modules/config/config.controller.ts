import { Request, Response, NextFunction } from "express";
import * as service from "./config.service";

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
