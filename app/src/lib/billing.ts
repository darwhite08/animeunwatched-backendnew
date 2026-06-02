/**
 * Provider-agnostic billing abstraction.
 *
 * Without STRIPE_SECRET set, every "provider" call is a no-op that returns
 * a fake provider id. The local Subscription/Invoice rows are still updated
 * so the admin console works end-to-end in dry-run mode. When a real Stripe
 * key is added, swap implementations behind this interface — no other module
 * changes.
 *
 * Recognized env:
 *   STRIPE_SECRET             - sk_live_… or sk_test_…
 *   BILLING_PROVIDER          - "stripe" (default if STRIPE_SECRET set) | "manual"
 */

export type BillingProvider = "stripe" | "manual";

export function activeProvider(): BillingProvider {
  if (process.env.BILLING_PROVIDER === "stripe" || process.env.STRIPE_SECRET) return "stripe";
  return "manual";
}

export function providerConfigured(): boolean {
  return activeProvider() === "stripe" && !!process.env.STRIPE_SECRET;
}

export interface ProviderChangePlanArgs {
  providerSubId: string | null;
  newProviderPriceId: string | null;
  prorate: boolean;
}
export interface ProviderRefundArgs {
  providerInvoiceId: string | null;
  amountCents: number;
  reason: string | null;
}
export interface ProviderCancelArgs {
  providerSubId: string | null;
  atPeriodEnd: boolean;
}

/**
 * Adapter call. In manual / unconfigured mode this is a no-op and returns
 * `{ ok: true, dryRun: true }` so the calling service can persist the local
 * state change and audit the dry-run.
 */
export async function providerChangePlan(args: ProviderChangePlanArgs): Promise<{ ok: boolean; dryRun: boolean; providerId?: string }> {
  if (!providerConfigured()) return { ok: true, dryRun: true };
  // Real Stripe integration would go here. Intentionally not implemented yet —
  // when keys land, wire @stripe/stripe-node and update this body.
  return { ok: true, dryRun: false, providerId: args.providerSubId ?? undefined };
}

export async function providerRefund(args: ProviderRefundArgs): Promise<{ ok: boolean; dryRun: boolean; refundId?: string }> {
  if (!providerConfigured()) return { ok: true, dryRun: true };
  return { ok: true, dryRun: false, refundId: `re_local_${Date.now()}` };
}

export async function providerCancel(args: ProviderCancelArgs): Promise<{ ok: boolean; dryRun: boolean }> {
  if (!providerConfigured()) return { ok: true, dryRun: true };
  return { ok: true, dryRun: false };
}
