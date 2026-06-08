/**
 * Stripe Connect integration for creator monetization (Phase 2).
 *
 * INERT until configured: every function checks `isStripeConfigured()` and the
 * caller returns 503 when STRIPE_SECRET_KEY is absent — so the app runs fine
 * without keys. When keys are set, this drives Connect onboarding, Checkout for
 * memberships/tips, webhook → earnings ledger, and payouts.
 *
 * Note (verified research): Stripe Connect cannot self-serve payouts to India/
 * Japan — those creators route to the PayPal rail (see payouts.ts). Pricing is
 * platform-controlled, so the platform is the 1099 filer.
 */
import Stripe from "stripe";
import { env } from "../../config/env";

let _stripe: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe not configured");
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion });
  return _stripe;
}

// ─── Connect onboarding (Express accounts) ───────────────────────────────────

/** Create (or reuse) an Express connected account for a creator and return a
 *  hosted onboarding link. Onboarding collects KYC + W-8/W-9 tax forms. */
export async function createConnectOnboarding(opts: {
  existingAcctId?: string | null;
  email?: string | null;
  country?: string | null;
}): Promise<{ accountId: string; url: string }> {
  const s = stripe();
  let accountId = opts.existingAcctId ?? null;
  if (!accountId) {
    const acct = await s.accounts.create({
      type: "express",
      email: opts.email ?? undefined,
      country: opts.country ?? undefined,
      capabilities: { transfers: { requested: true } },
      business_type: "individual",
    });
    accountId = acct.id;
  }
  const link = await s.accountLinks.create({
    account: accountId,
    refresh_url: env.STRIPE_CONNECT_RETURN_URL,
    return_url: env.STRIPE_CONNECT_RETURN_URL,
    type: "account_onboarding",
  });
  return { accountId, url: link.url };
}

/** Current onboarding/payout status of a connected account. */
export async function getConnectStatus(accountId: string): Promise<{ onboarded: boolean; payoutsEnabled: boolean }> {
  const acct = await stripe().accounts.retrieve(accountId);
  return { onboarded: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled };
}

// ─── Checkout (membership subscription + one-off tip) ────────────────────────

/** Subscription Checkout for a membership tier. The 10% platform fee is taken
 *  via application_fee_percent; the remaining 90% transfers to the creator. */
export async function createMembershipCheckout(opts: {
  creatorAcctId: string;
  tier: { id: string; name: string; priceCents: number; currency: string };
  fanId: string;
  creatorId: string;
}): Promise<{ url: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{
      price_data: {
        currency: opts.tier.currency.toLowerCase(),
        product_data: { name: `Membership: ${opts.tier.name}` },
        recurring: { interval: "month" },
        unit_amount: opts.tier.priceCents,
      },
      quantity: 1,
    }],
    subscription_data: {
      application_fee_percent: 10, // platform keeps 10%, creator nets 90%
      transfer_data: { destination: opts.creatorAcctId },
    },
    metadata: { kind: "membership", tierId: opts.tier.id, fanId: opts.fanId, creatorId: opts.creatorId },
    success_url: `${env.STRIPE_CHECKOUT_SUCCESS_URL}?membership=success`,
    cancel_url: `${env.STRIPE_CHECKOUT_SUCCESS_URL}?membership=cancel`,
  });
  return { url: session.url! };
}

/** One-off tip Checkout (destination charge, 10% application fee). */
export async function createTipCheckout(opts: {
  creatorAcctId: string;
  amountCents: number;
  currency: string;
  fanId: string;
  creatorId: string;
  message?: string;
}): Promise<{ url: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: opts.currency.toLowerCase(),
        product_data: { name: "Tip" },
        unit_amount: opts.amountCents,
      },
      quantity: 1,
    }],
    payment_intent_data: {
      application_fee_amount: Math.round(opts.amountCents * 0.1),
      transfer_data: { destination: opts.creatorAcctId },
    },
    metadata: { kind: "tip", fanId: opts.fanId, creatorId: opts.creatorId, message: opts.message ?? "" },
    success_url: `${env.STRIPE_CHECKOUT_SUCCESS_URL}?tip=success`,
    cancel_url: `${env.STRIPE_CHECKOUT_SUCCESS_URL}?tip=cancel`,
  });
  return { url: session.url! };
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/** Verify + parse a Stripe webhook from the raw body. */
export function parseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
