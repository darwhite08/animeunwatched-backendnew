import type { Request, Response, NextFunction } from "express";
import * as service from "./monetization.service";

const uid = (res: Response): string => res.locals.user.id;
const range = (req: Request): string => {
  const r = (req.query.range as string) || "28d";
  return /^\d+d$/.test(r) ? r : "28d";
};

export async function getEligibility(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.checkEligibility(uid(res))); } catch (e) { next(e); }
}

export async function getTiers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json({ tiers: await service.listTiers(uid(res)) }); } catch (e) { next(e); }
}

export async function postTier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description, priceCents, currency, perks } = req.body ?? {};
    res.status(201).json(await service.createTier(uid(res), { name, description, priceCents: Number(priceCents), currency, perks }));
  } catch (e) { next(e); }
}

export async function patchTier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    res.status(200).json(await service.updateTier(uid(res), id, req.body ?? {}));
  } catch (e) { next(e); }
}

export async function getRevenue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getRevenueSummary(uid(res), range(req))); } catch (e) { next(e); }
}

export async function getPayouts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getPayouts(uid(res))); } catch (e) { next(e); }
}
