import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";
import { activeProvider, providerConfigured, providerChangePlan, providerRefund, providerCancel } from "../../lib/billing";
import { broadcastAdminBillingChanged } from "../../realtime/broadcast";

/**
 * M5 — billing. All mutations write a local Subscription/Invoice row AND
 * call the provider adapter. In dry-run mode (no STRIPE_SECRET) the adapter
 * is a no-op; the local rows still update and the audit log records dry-run.
 */

export function getProviderStatus(_req: Request, res: Response): void {
  res.status(200).json({
    provider:    activeProvider(),
    configured:  providerConfigured(),
    dryRunMode:  !providerConfigured(),
  });
}

// ── Plans ────────────────────────────────────────────────────────────────────

export async function listPlans(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.plan.findMany({ orderBy: { priceCents: "asc" } });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function createPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { key, name, description, priceCents, currency, interval, trialDays, features, providerPriceId, isPublic } = req.body as Record<string, unknown>;
    if (typeof key !== "string" || typeof name !== "string" || typeof priceCents !== "number") {
      throw badRequest("key, name, priceCents required");
    }
    const plan = await prisma.plan.create({
      data: {
        key, name,
        description:     typeof description === "string" ? description : null,
        priceCents,
        currency:        typeof currency === "string" ? currency : "USD",
        interval:        typeof interval === "string" ? interval : "month",
        trialDays:       typeof trialDays === "number" ? trialDays : 0,
        features:        (features ?? []) as never,
        providerPriceId: typeof providerPriceId === "string" ? providerPriceId : null,
        isPublic:        isPublic !== false,
      },
    });
    await adminAuditR(req, res, {
      action: "billing.plan_create", targetType: "Plan", targetId: plan.id,
      metadata: { key, priceCents },
    });
    res.status(200).json({ plan });
  } catch (err) { next(err); }
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export async function listSubscriptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (userId) where.userId = userId;

    const [data, total] = await prisma.$transaction([
      prisma.subscription.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
        include: { plan: { select: { key: true, name: true, priceCents: true, interval: true } } },
      }),
      prisma.subscription.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function getSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sub = await prisma.subscription.findUnique({
      where:   { id: req.params.id as string },
      include: { plan: true, invoices: { orderBy: { createdAt: "desc" }, take: 50 } },
    });
    if (!sub) throw notFound("Subscription not found");
    res.status(200).json(sub);
  } catch (err) { next(err); }
}

export async function changePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const { planId, prorate } = req.body as { planId?: string; prorate?: boolean };
    if (!planId) throw badRequest("planId required");
    const [sub, newPlan] = await Promise.all([
      prisma.subscription.findUnique({ where: { id } }),
      prisma.plan.findUnique({ where: { id: planId } }),
    ]);
    if (!sub) throw notFound("Subscription not found");
    if (!newPlan) throw notFound("Plan not found");

    const result = await providerChangePlan({
      providerSubId:       sub.providerSubId,
      newProviderPriceId:  newPlan.providerPriceId,
      prorate:             prorate ?? true,
    });

    const updated = await prisma.subscription.update({
      where: { id }, data: { planId },
    });

    await adminAuditR(req, res, {
      action: "billing.change_plan", targetType: "Subscription", targetId: id,
      metadata: { from: sub.planId, to: planId, prorate, dryRun: result.dryRun },
    });
    broadcastAdminBillingChanged("change_plan", id);
    res.status(200).json({ subscription: updated, dryRun: result.dryRun });
  } catch (err) { next(err); }
}

export async function refundInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;   // invoice id
    const { amountCents, reason } = req.body as { amountCents?: number; reason?: string };
    const inv = await prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound("Invoice not found");
    if (inv.status === "REFUNDED" || inv.refundedAmount >= inv.amountCents) throw badRequest("Already refunded");

    const amount = typeof amountCents === "number" ? amountCents : inv.amountCents - inv.refundedAmount;
    if (amount <= 0 || amount > inv.amountCents - inv.refundedAmount) throw badRequest("Invalid refund amount");

    const result = await providerRefund({
      providerInvoiceId: inv.providerInvoiceId,
      amountCents:        amount,
      reason:             reason ?? null,
    });

    const newRefunded = inv.refundedAmount + amount;
    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        refundedAmount: newRefunded,
        refundedAt:     new Date(),
        refundReason:   reason ?? null,
        status:         newRefunded >= inv.amountCents ? "REFUNDED" : inv.status,
      },
    });

    await adminAuditR(req, res, {
      action: "billing.refund", targetType: "Invoice", targetId: id,
      metadata: { amountCents: amount, totalRefunded: newRefunded, reason, dryRun: result.dryRun },
    });
    broadcastAdminBillingChanged("refund", id);
    res.status(200).json({ invoice: updated, dryRun: result.dryRun });
  } catch (err) { next(err); }
}

export async function creditSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const { amountCents, reason } = req.body as { amountCents?: number; reason?: string };
    if (typeof amountCents !== "number" || amountCents <= 0) throw badRequest("amountCents > 0 required");
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound("Subscription not found");

    // Credits land as a negative-amount invoice with status PAID so reconciliation works.
    const inv = await prisma.invoice.create({
      data: {
        subscriptionId: id,
        amountCents:    -amountCents,
        currency:       "USD",
        status:         "PAID",
        paidAt:         new Date(),
        failureReason:  null,
      },
    });
    await adminAuditR(req, res, {
      action: "billing.credit", targetType: "Subscription", targetId: id,
      metadata: { invoiceId: inv.id, amountCents, reason },
    });
    broadcastAdminBillingChanged("credit", id);
    res.status(200).json({ invoice: inv });
  } catch (err) { next(err); }
}

export async function extendTrial(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const { days } = req.body as { days?: number };
    if (typeof days !== "number" || days <= 0) throw badRequest("days > 0 required");
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound("Subscription not found");
    const newTrialEnd = new Date((sub.trialEndsAt?.getTime() ?? Date.now()) + days * 86_400_000);
    const updated = await prisma.subscription.update({
      where: { id },
      data: { trialEndsAt: newTrialEnd, status: "TRIALING" },
    });
    await adminAuditR(req, res, {
      action: "billing.extend_trial", targetType: "Subscription", targetId: id,
      metadata: { days, newTrialEndsAt: newTrialEnd.toISOString() },
    });
    broadcastAdminBillingChanged("extend_trial", id);
    res.status(200).json({ subscription: updated });
  } catch (err) { next(err); }
}

export async function cancelSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const { atPeriodEnd } = req.body as { atPeriodEnd?: boolean };
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound("Subscription not found");

    const result = await providerCancel({
      providerSubId: sub.providerSubId,
      atPeriodEnd:   atPeriodEnd ?? true,
    });

    const updated = await prisma.subscription.update({
      where: { id },
      data: atPeriodEnd
        ? { cancelAtPeriodEnd: true }
        : { status: "CANCELED", canceledAt: new Date() },
    });
    await adminAuditR(req, res, {
      action: "billing.cancel", targetType: "Subscription", targetId: id,
      metadata: { atPeriodEnd, dryRun: result.dryRun },
    });
    broadcastAdminBillingChanged("cancel", id);
    res.status(200).json({ subscription: updated, dryRun: result.dryRun });
  } catch (err) { next(err); }
}

/** Billing-event reconciliation receiver (admin-gated; see route comment). */
export async function receiveBillingWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Defense-in-depth: if a shared secret is configured, require it. This keeps
    // the endpoint safe from event injection even if it were ever exposed
    // outside the admin guard. (The signature-verified provider webhook is the
    // monetization Stripe handler; this path is for manual/admin reconciliation.)
    const requiredSecret = process.env.BILLING_WEBHOOK_SECRET;
    if (requiredSecret && req.header("x-kaiveron-webhook-secret") !== requiredSecret) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid webhook secret" } });
      return;
    }
    const provider = (req.params.provider as string) ?? "stripe";
    const body = req.body as { id?: string; type?: string };
    if (!body?.id || !body?.type) throw badRequest("event must have id + type");
    await prisma.billingEvent.upsert({
      where:  { eventId: body.id },
      update: {},
      create: { provider, eventType: body.type, eventId: body.id, payload: body as never },
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
