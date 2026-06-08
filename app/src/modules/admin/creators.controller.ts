import { Request, Response, NextFunction } from "express";
import * as service from "./creators.service";

/** GET /admin/creators?q=&status=&take= — find users + their creator status. */
export async function listCreators(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const take = req.query.take ? Number(req.query.take) : undefined;
    res.status(200).json(await service.listCreators({ q, status, take }));
  } catch (err) { next(err); }
}

/** POST /admin/creators/:userId/grant — enable Creator Studio for this user. */
export async function grantCreator(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId = req.params.userId as string;
    res.status(200).json(await service.setCreatorGrant({ actorId, userId, grant: true }));
  } catch (err) { next(err); }
}

/** POST /admin/creators/:userId/revoke — remove the manual Studio grant. */
export async function revokeCreator(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId = req.params.userId as string;
    res.status(200).json(await service.setCreatorGrant({ actorId, userId, grant: false }));
  } catch (err) { next(err); }
}

/** POST /admin/creators/:userId/bonus — one-time early-signup credit (default $100). */
export async function grantBonus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId = req.params.userId as string;
    const amountCents = req.body?.amountCents != null ? Number(req.body.amountCents) : 10000;
    res.status(200).json(await service.grantEarlySignupBonus({ actorId, userId, amountCents }));
  } catch (err) { next(err); }
}

/** POST /admin/creators/:userId/bonus/revoke — claw back an unpaid early-signup grant. */
export async function revokeBonus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId = req.params.userId as string;
    res.status(200).json(await service.revokeEarlySignupBonus({ actorId, userId }));
  } catch (err) { next(err); }
}
