import { prisma } from "../../config/prisma";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import {
  EARNINGS_HOLD_DAYS,
  MIN_PAYOUT_CENTS,
  computeSplit,
  evaluateEligibility,
} from "../../lib/monetizationMath";

// ─── Eligibility ──────────────────────────────────────────────────────────────

export async function checkEligibility(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, reputation: true, isBanned: true, isShadowBanned: true },
  });
  if (!user) throw notFound("User not found");

  const followers = await prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } });
  const accountAgeDays = (Date.now() - user.createdAt.getTime()) / 86_400_000;
  const result = evaluateEligibility({
    followers,
    reputation: user.reputation,
    accountAgeDays,
    inGoodStanding: !user.isBanned && !user.isShadowBanned,
  });

  const profile = await prisma.creatorProfile.upsert({
    where: { userId },
    create: {
      userId, isEligible: result.isEligible, status: result.isEligible ? "eligible" : "pending",
      eligibleAt: result.isEligible ? new Date() : null, followersAtCheck: followers, reputationAtCheck: user.reputation,
    },
    update: {
      isEligible: result.isEligible, followersAtCheck: followers, reputationAtCheck: user.reputation,
      ...(result.isEligible ? { status: "eligible", eligibleAt: new Date() } : {}),
    },
  });

  return { isEligible: result.isEligible, reasons: result.reasons, status: profile.status, followers, reputation: user.reputation };
}

async function assertEligible(userId: string) {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { isEligible: true } });
  const eligible = profile?.isEligible ?? (await checkEligibility(userId)).isEligible;
  if (!eligible) throw forbidden("Not yet eligible to monetize");
}

// ─── Tiers ────────────────────────────────────────────────────────────────────

export async function listTiers(creatorId: string) {
  return prisma.creatorTier.findMany({
    where: { creatorId, active: true },
    orderBy: { priceCents: "asc" },
    include: { _count: { select: { memberships: { where: { status: "active" } } } } },
  });
}

export async function createTier(creatorId: string, data: { name: string; description?: string; priceCents: number; currency?: string; perks?: string[] }) {
  await assertEligible(creatorId);
  if (data.priceCents < 100) throw badRequest("Minimum tier price is 100 cents");
  if (!data.name?.trim()) throw badRequest("Tier name required");
  return prisma.creatorTier.create({
    data: {
      creatorId, name: data.name.trim(), description: data.description ?? null,
      priceCents: Math.round(data.priceCents), currency: data.currency ?? "USD", perks: data.perks ?? [],
    },
  });
}

export async function updateTier(creatorId: string, tierId: string, data: Partial<{ name: string; description: string; perks: string[]; active: boolean }>) {
  const tier = await prisma.creatorTier.findUnique({ where: { id: tierId }, select: { creatorId: true } });
  if (!tier || tier.creatorId !== creatorId) throw notFound("Tier not found");
  return prisma.creatorTier.update({ where: { id: tierId }, data });
}

// ─── Earnings ledger (the 90/10 split, single source of truth) ───────────────

/**
 * Record an inflow into the earnings ledger with the 90/10 split. New earnings
 * enter a 7-day hold before becoming payable. Used by the payment webhooks
 * (Phase 2) and by simulated transactions in tests/Phase 1.
 */
export async function recordEarning(args: {
  creatorId: string;
  source: "membership" | "tip" | "unlock";
  sourceId?: string;
  grossCents: number;
  currency?: string;
}) {
  const split = computeSplit(args.grossCents);
  return prisma.creatorEarning.create({
    data: {
      creatorId: args.creatorId,
      source: args.source,
      sourceId: args.sourceId ?? null,
      grossCents: split.grossCents,
      processorFeeCents: split.processorFeeCents,
      platformFeeCents: split.platformFeeCents,
      netCents: split.netCents,
      currency: args.currency ?? "USD",
      status: "pending",
      availableAt: new Date(Date.now() + EARNINGS_HOLD_DAYS * 86_400_000),
    },
  });
}

/** Move held earnings past their hold window to `available` (run by a job/cron). */
export async function releaseHeldEarnings(): Promise<number> {
  const { count } = await prisma.creatorEarning.updateMany({
    where: { status: "pending", availableAt: { lte: new Date() } },
    data: { status: "available" },
  });
  return count;
}

// ─── Revenue summary (Creator Studio "Revenue" tab — Patreon-style funnel) ───

export async function getRevenueSummary(creatorId: string, range = "28d") {
  const days = Math.min(365, Math.max(1, Number(/^(\d+)d$/.exec(range)?.[1] ?? 28)));
  const since = new Date(Date.now() - days * 86_400_000);

  const [windowAgg, lifetimeAgg, available, pending, activeMembers, tiers, tipsAgg, recent] = await Promise.all([
    prisma.creatorEarning.aggregate({
      where: { creatorId, createdAt: { gte: since } },
      _sum: { grossCents: true, platformFeeCents: true, processorFeeCents: true, netCents: true },
    }),
    prisma.creatorEarning.aggregate({ where: { creatorId, status: { not: "refunded" } }, _sum: { netCents: true } }),
    prisma.creatorEarning.aggregate({ where: { creatorId, status: "available" }, _sum: { netCents: true } }),
    prisma.creatorEarning.aggregate({ where: { creatorId, status: "pending" }, _sum: { netCents: true } }),
    prisma.creatorMembership.count({ where: { creatorId, status: "active" } }),
    prisma.creatorTier.findMany({ where: { creatorId, active: true }, select: { priceCents: true, memberships: { where: { status: "active" }, select: { id: true } } } }),
    prisma.tip.aggregate({ where: { toCreatorId: creatorId, createdAt: { gte: since } }, _sum: { amountCents: true }, _count: true }),
    prisma.creatorEarning.findMany({ where: { creatorId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  // MRR = Σ (active members in a tier × tier price)
  const mrrCents = tiers.reduce((sum, t) => sum + t.priceCents * t.memberships.length, 0);

  return {
    funnel: {
      grossCents: windowAgg._sum.grossCents ?? 0,
      platformFeeCents: windowAgg._sum.platformFeeCents ?? 0,
      processorFeeCents: windowAgg._sum.processorFeeCents ?? 0,
      netCents: windowAgg._sum.netCents ?? 0,
    },
    balanceCents: available._sum.netCents ?? 0,
    pendingCents: pending._sum.netCents ?? 0,
    lifetimeNetCents: lifetimeAgg._sum.netCents ?? 0,
    minPayoutCents: MIN_PAYOUT_CENTS,
    activeMembers,
    mrrCents,
    tips: { totalCents: tipsAgg._sum.amountCents ?? 0, count: tipsAgg._count },
    recent: recent.map((e) => ({
      id: e.id, source: e.source, grossCents: e.grossCents, netCents: e.netCents,
      status: e.status, createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function getPayouts(creatorId: string) {
  const [account, payouts, balance] = await Promise.all([
    prisma.payoutAccount.findUnique({ where: { userId: creatorId } }),
    prisma.payout.findMany({ where: { creatorId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.creatorEarning.aggregate({ where: { creatorId, status: "available" }, _sum: { netCents: true } }),
  ]);
  return {
    onboarded: account?.onboarded ?? false,
    payoutsEnabled: account?.payoutsEnabled ?? false,
    taxFormStatus: account?.taxFormStatus ?? "missing",
    balanceCents: balance._sum.netCents ?? 0,
    minPayoutCents: MIN_PAYOUT_CENTS,
    payouts: payouts.map((p) => ({
      id: p.id, amountCents: p.amountCents, status: p.status, provider: p.provider, createdAt: p.createdAt.toISOString(),
    })),
  };
}
