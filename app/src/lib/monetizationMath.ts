/**
 * Monetization money math — pure, integer-cents, unit-testable.
 * (docs/monetization-system.md). The promise to creators is "keep 90%": the
 * platform's 10% fee absorbs the payment-processor cost (Substack/FANBOX model).
 */

export const PLATFORM_FEE_BPS = 1000; // 10.00%

export interface Split {
  grossCents: number;
  platformFeeCents: number; // 10% of gross — the platform's cut
  processorFeeCents: number; // estimated Stripe cost, BORNE BY PLATFORM (informational)
  netCents: number; // what the creator keeps = gross − platformFee (= 90%)
}

/** Split a gross inflow. Creator nets 90%; processor fee is platform-borne. */
export function computeSplit(grossCents: number): Split {
  const gross = Math.max(0, Math.round(grossCents));
  const platformFeeCents = Math.round((gross * PLATFORM_FEE_BPS) / 10_000);
  const processorFeeCents = gross > 0 ? Math.round(gross * 0.029) + 30 : 0; // Stripe std estimate
  const netCents = gross - platformFeeCents;
  return { grossCents: gross, platformFeeCents, processorFeeCents, netCents };
}

/** Platform's actual margin after paying the processor out of its 10%. */
export function platformMargin(split: Split): number {
  return split.platformFeeCents - split.processorFeeCents;
}

// ─── Eligibility (YPP-style gate, Kaiveron-scaled) ───────────────────────────

export const ELIGIBILITY = {
  MIN_FOLLOWERS: 100,
  MIN_REPUTATION: 200,
  MIN_ACCOUNT_AGE_DAYS: 30,
} as const;

export interface EligibilityInput {
  followers: number;
  reputation: number;
  accountAgeDays: number;
  inGoodStanding: boolean; // not banned/shadow-banned
}

export interface EligibilityResult {
  isEligible: boolean;
  reasons: string[]; // unmet requirements (empty when eligible)
}

export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (i.followers < ELIGIBILITY.MIN_FOLLOWERS) reasons.push(`Need ${ELIGIBILITY.MIN_FOLLOWERS} followers (have ${i.followers})`);
  if (i.reputation < ELIGIBILITY.MIN_REPUTATION) reasons.push(`Need ${ELIGIBILITY.MIN_REPUTATION} reputation (have ${i.reputation})`);
  if (i.accountAgeDays < ELIGIBILITY.MIN_ACCOUNT_AGE_DAYS) reasons.push(`Account must be ${ELIGIBILITY.MIN_ACCOUNT_AGE_DAYS} days old`);
  if (!i.inGoodStanding) reasons.push("Account not in good standing");
  return { isEligible: reasons.length === 0, reasons };
}

/** New earnings are held this long before becoming payable (refund/chargeback cover). */
export const EARNINGS_HOLD_DAYS = 7;
/** Minimum balance before a payout can be requested. */
export const MIN_PAYOUT_CENTS = 2500; // $25
