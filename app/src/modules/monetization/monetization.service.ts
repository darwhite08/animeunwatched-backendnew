import type Stripe from "stripe";
import { prisma } from "../../config/prisma";
import { badRequest, configError, forbidden, notFound } from "../../lib/errors";
import {
  EARNINGS_HOLD_DAYS,
  MIN_PAYOUT_CENTS,
  computeSplit,
  evaluateEligibility,
} from "../../lib/monetizationMath";
import {
  createConnectOnboarding,
  createMembershipCheckout,
  createTipCheckout,
  getConnectStatus,
  isStripeConfigured,
} from "../../lib/payments/stripe";

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
      // Exclude refunded earnings (e.g. revoked admin grants) so the period
      // revenue funnel drops when a grant is clawed back — matching the
      // lifetime/available aggregates below.
      where: { creatorId, createdAt: { gte: since }, status: { not: "refunded" } },
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

// ─── Payments (Phase 2 — Stripe Connect; inert until configured) ─────────────

/** Start/continue Stripe Connect onboarding for a creator. */
export async function startOnboarding(creatorId: string): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw configError("Payments not configured");
  await assertEligible(creatorId);
  const [user, account] = await Promise.all([
    prisma.user.findUnique({ where: { id: creatorId }, select: { email: true } }),
    prisma.payoutAccount.findUnique({ where: { userId: creatorId } }),
  ]);
  const country = (await prisma.creatorProfile.findUnique({ where: { userId: creatorId }, select: { payoutCountry: true } }))?.payoutCountry;
  const { accountId, url } = await createConnectOnboarding({
    existingAcctId: account?.providerAcctId, email: user?.email, country,
  });
  await prisma.payoutAccount.upsert({
    where: { userId: creatorId },
    create: { userId: creatorId, provider: "stripe", providerAcctId: accountId, country },
    update: { providerAcctId: accountId },
  });
  return { url };
}

/** Refresh + persist Connect onboarding/payout status. */
export async function refreshOnboardingStatus(creatorId: string): Promise<void> {
  const account = await prisma.payoutAccount.findUnique({ where: { userId: creatorId } });
  if (!account?.providerAcctId || !isStripeConfigured()) return;
  const status = await getConnectStatus(account.providerAcctId);
  await prisma.payoutAccount.update({
    where: { userId: creatorId },
    data: { onboarded: status.onboarded, payoutsEnabled: status.payoutsEnabled },
  });
}

/** Create a membership-subscription Checkout for a fan → creator/tier. */
export async function checkoutMembership(fanId: string, tierId: string): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw configError("Payments not configured");
  const tier = await prisma.creatorTier.findUnique({ where: { id: tierId } });
  if (!tier || !tier.active) throw notFound("Tier not found");
  const acct = await prisma.payoutAccount.findUnique({ where: { userId: tier.creatorId } });
  if (!acct?.providerAcctId || !acct.payoutsEnabled) throw badRequest("Creator hasn't completed payout onboarding");
  if (fanId === tier.creatorId) throw badRequest("You can't subscribe to yourself");
  return createMembershipCheckout({
    creatorAcctId: acct.providerAcctId, creatorId: tier.creatorId, fanId,
    tier: { id: tier.id, name: tier.name, priceCents: tier.priceCents, currency: tier.currency },
  });
}

/** Create a one-off tip Checkout. */
export async function checkoutTip(fanId: string, creatorId: string, amountCents: number, message?: string): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw configError("Payments not configured");
  if (amountCents < 100) throw badRequest("Minimum tip is 100 cents");
  if (fanId === creatorId) throw badRequest("You can't tip yourself");
  const acct = await prisma.payoutAccount.findUnique({ where: { userId: creatorId } });
  if (!acct?.providerAcctId || !acct.payoutsEnabled) throw badRequest("Creator can't receive tips yet");
  const currency = (await prisma.creatorProfile.findUnique({ where: { userId: creatorId }, select: { defaultCurrency: true } }))?.defaultCurrency ?? "USD";
  return createTipCheckout({ creatorAcctId: acct.providerAcctId, creatorId, fanId, amountCents, currency, message });
}

/**
 * Map a verified Stripe webhook event to our ledger/tables. Idempotent per
 * Stripe object id. (Stripe Connect destination charges put the creator's 90%
 * directly in their Stripe balance and auto-pay to their bank — the ledger
 * here is the analytics mirror that powers the Revenue tab.)
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as unknown as Stripe.Checkout.Session;
      const m = s.metadata ?? {};
      if (m.kind === "membership" && m.fanId && m.creatorId && m.tierId) {
        await prisma.creatorMembership.upsert({
          where: { fanId_creatorId: { fanId: m.fanId, creatorId: m.creatorId } },
          create: { fanId: m.fanId, creatorId: m.creatorId, tierId: m.tierId, status: "active", provider: "stripe", providerSubId: (s.subscription as string) ?? null },
          update: { status: "active", tierId: m.tierId, providerSubId: (s.subscription as string) ?? null, canceledAt: null },
        });
        // first-period earning is recorded on the invoice.paid event below
      } else if (m.kind === "tip" && m.fanId && m.creatorId && s.amount_total) {
        const tip = await prisma.tip.create({
          data: { fromUserId: m.fanId, toCreatorId: m.creatorId, amountCents: s.amount_total, currency: (s.currency ?? "usd").toUpperCase(), message: m.message || null, provider: "stripe", providerRef: s.id },
        });
        await recordEarning({ creatorId: m.creatorId, source: "tip", sourceId: tip.id, grossCents: s.amount_total, currency: tip.currency });
      }
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as unknown as Stripe.Invoice;
      const sub = inv.subscription as string | null;
      if (!sub || !inv.amount_paid) break;
      const membership = await prisma.creatorMembership.findFirst({ where: { providerSubId: sub }, select: { creatorId: true, id: true } });
      if (membership) {
        await recordEarning({ creatorId: membership.creatorId, source: "membership", sourceId: membership.id, grossCents: inv.amount_paid, currency: (inv.currency ?? "usd").toUpperCase() });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as unknown as Stripe.Subscription;
      await prisma.creatorMembership.updateMany({ where: { providerSubId: sub.id }, data: { status: "canceled", canceledAt: new Date() } });
      break;
    }
  }
}

/**
 * Subscriber retention cohorts (Substack-style): group memberships by signup
 * month, show how many remain active vs churned, plus net growth. Powers the
 * Revenue tab's Retention section.
 */
export async function getRetention(creatorId: string) {
  const memberships = await prisma.creatorMembership.findMany({
    where: { creatorId },
    select: { createdAt: true, status: true, canceledAt: true },
  });

  const cohorts = new Map<string, { total: number; retained: number }>();
  for (const m of memberships) {
    const key = m.createdAt.toISOString().slice(0, 7); // YYYY-MM
    const c = cohorts.get(key) ?? { total: 0, retained: 0 };
    c.total += 1;
    if (m.status === "active") c.retained += 1;
    cohorts.set(key, c);
  }

  const active = memberships.filter((m) => m.status === "active").length;
  const churned = memberships.filter((m) => m.status === "canceled").length;
  const retentionRate = memberships.length > 0 ? active / memberships.length : 0;

  return {
    activeMembers: active,
    churnedMembers: churned,
    retentionRate,
    cohorts: [...cohorts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, c]) => ({ month, joined: c.total, retained: c.retained, retentionPct: c.total ? (c.retained / c.total) * 100 : 0 })),
  };
}

/** Public-facing creator monetization: tiers + whether they accept support.
 *  Used by the consumer profile to show Subscribe / Tip. Looked up by username. */
export async function getPublicCreator(username: string, viewerId?: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, displayName: true, avatarUrl: true },
  });
  if (!user) throw notFound("Creator not found");

  const [profile, tiers, membership] = await Promise.all([
    prisma.creatorProfile.findUnique({ where: { userId: user.id }, select: { status: true, isEligible: true } }),
    prisma.creatorTier.findMany({
      where: { creatorId: user.id, active: true },
      orderBy: { priceCents: "asc" },
      select: { id: true, name: true, description: true, priceCents: true, currency: true, perks: true },
    }),
    viewerId ? prisma.creatorMembership.findUnique({ where: { fanId_creatorId: { fanId: viewerId, creatorId: user.id } }, select: { tierId: true, status: true } }) : Promise.resolve(null),
  ]);

  const isMonetized = !!profile && (profile.status === "active" || profile.status === "eligible" || profile.isEligible);
  return {
    creatorId: user.id,
    username: user.username,
    displayName: user.displayName,
    isMonetized,
    isSelf: viewerId === user.id,
    myTierId: membership?.status === "active" ? membership.tierId : null,
    tiers,
  };
}

/** Supporters list (Patreon-style Membership Insights) + headline counts. */
export async function getMembers(creatorId: string) {
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const memberships = await prisma.creatorMembership.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, status: true, createdAt: true, canceledAt: true,
      fan: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      tier: { select: { id: true, name: true, priceCents: true } },
    },
  });

  const active = memberships.filter((m) => m.status === "active");
  const counts = {
    active: active.length,
    new30d: memberships.filter((m) => m.createdAt >= monthAgo).length,
    canceled30d: memberships.filter((m) => m.status === "canceled" && m.canceledAt && m.canceledAt >= monthAgo).length,
    total: memberships.length,
    mrrCents: active.reduce((s, m) => s + (m.tier?.priceCents ?? 0), 0),
  };

  return {
    counts,
    members: memberships.map((m) => ({
      id: m.id,
      status: m.status,
      since: m.createdAt.toISOString(),
      canceledAt: m.canceledAt?.toISOString() ?? null,
      fan: m.fan,
      tier: m.tier ? { id: m.tier.id, name: m.tier.name, priceCents: m.tier.priceCents } : null,
    })),
  };
}

/** Daily net-earnings time series (split membership vs tip) for the Revenue chart. */
export async function getRevenueSeries(creatorId: string, range = "28d") {
  const days = Math.min(365, Math.max(1, Number(/^(\d+)d$/.exec(range)?.[1] ?? 28)));
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await prisma.$queryRaw<Array<{ day: Date; source: string; net: number }>>`
    SELECT date_trunc('day', "createdAt")::date AS day, source, SUM("netCents")::int AS net
      FROM "CreatorEarning"
     WHERE "creatorId" = ${creatorId} AND "createdAt" >= ${since} AND status <> 'refunded'
     GROUP BY 1, 2 ORDER BY 1
  `;

  const byDay = new Map<string, { membership: number; tip: number; unlock: number }>();
  for (const r of rows) {
    const k = r.day.toISOString().slice(0, 10);
    const e = byDay.get(k) ?? { membership: 0, tip: 0, unlock: 0 };
    if (r.source === "membership") e.membership += r.net;
    else if (r.source === "tip") e.tip += r.net;
    else e.unlock += r.net;
    byDay.set(k, e);
  }

  const series: { date: string; membership: number; tip: number; total: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const e = byDay.get(d) ?? { membership: 0, tip: 0, unlock: 0 };
    series.push({ date: d, membership: e.membership, tip: e.tip, total: e.membership + e.tip + e.unlock });
  }
  return { series };
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
