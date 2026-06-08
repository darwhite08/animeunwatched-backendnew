import type { Request, Response, NextFunction } from "express";
import * as service from "./monetization.service";
import { badRequest } from "../../lib/errors";
import { isStripeConfigured, parseWebhook } from "../../lib/payments/stripe";

/**
 * Stripe webhook — mounted in app.ts with express.raw() BEFORE express.json so
 * the raw body is available for signature verification. Returns 200 fast.
 */
export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  if (!isStripeConfigured()) { res.status(503).end(); return; }
  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") { res.status(400).send("missing signature"); return; }
  let event;
  try {
    event = parseWebhook(req.body as Buffer, sig);
  } catch (err) {
    res.status(400).send(`webhook signature failed: ${(err as Error).message}`);
    return;
  }
  // Ack immediately; process async so a slow handler can't trip Stripe retries.
  res.status(200).json({ received: true });
  service.handleStripeEvent(event).catch((e) => console.error("[stripe webhook]", (e as Error).message));
}

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

export async function getRetention(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getRetention(uid(res))); } catch (e) { next(e); }
}

// ── Payments (Phase 2) ──
export async function postOnboard(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.refreshOnboardingStatus(uid(res)); res.status(200).json(await service.startOnboarding(uid(res))); } catch (e) { next(e); }
}

export async function postCheckoutMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tierId = (req.body?.tierId as string) ?? "";
    if (!tierId) throw badRequest("tierId required");
    res.status(200).json(await service.checkoutMembership(uid(res), tierId));
  } catch (e) { next(e); }
}

export async function postCheckoutTip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { creatorId, amountCents, message } = req.body ?? {};
    if (!creatorId) throw badRequest("creatorId required");
    res.status(200).json(await service.checkoutTip(uid(res), creatorId, Number(amountCents), message));
  } catch (e) { next(e); }
}
