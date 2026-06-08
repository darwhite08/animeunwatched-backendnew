import { prisma } from "../../config/prisma";
import { notFound, conflict, badRequest } from "../../lib/errors";
import { auditMod } from "../../lib/audit";

// Min/max sanity bounds for a manual early-signup grant ($1 – $1,000).
const GRANT_MIN_CENTS = 100;
const GRANT_MAX_CENTS = 100_000;

// ─── Admin creator management ──────────────────────────────────────────────────
// The Creator Studio is gated: most users are not creators. These endpoints let
// an admin hand-pick "selected few" by setting CreatorProfile.status = "active",
// which the studio access gate (GET /creator/access) honours directly.

type CreatorStatus = "none" | "pending" | "eligible" | "active" | "suspended";

/** Paginated list of users with their creator status, for the admin "invite a
 *  creator" screen. Searchable by username / displayName / email. */
export async function listCreators(opts: { q?: string; status?: string; take?: number }) {
  const take = Math.min(Math.max(opts.take ?? 25, 1), 100);
  const q = opts.q?.trim();

  const users = await prisma.user.findMany({
    where: {
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" } },
              { displayName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(opts.status ? { creatorProfile: { status: opts.status } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true, username: true, displayName: true, email: true,
      avatarUrl: true, reputation: true, createdAt: true,
      creatorProfile: { select: { status: true, isEligible: true, eligibleAt: true } },
      _count: { select: { followers: true, blogs: true } },
    },
  });

  // Sum each user's early-signup grant (source="grant") so the admin list can
  // show who already received one — also the source of truth for the once-only
  // guard on the grant endpoint.
  const ids = users.map((u) => u.id);
  const grants = ids.length
    ? await prisma.creatorEarning.groupBy({
        by: ["creatorId"],
        where: { creatorId: { in: ids }, source: "grant" },
        _sum: { grossCents: true },
      })
    : [];
  const grantMap = new Map(grants.map((g) => [g.creatorId, g._sum.grossCents ?? 0]));

  return {
    items: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      avatarUrl: u.avatarUrl,
      reputation: u.reputation,
      followers: u._count.followers,
      blogs: u._count.blogs,
      createdAt: u.createdAt.toISOString(),
      status: (u.creatorProfile?.status ?? "none") as CreatorStatus,
      isStudioGranted: u.creatorProfile?.status === "active",
      eligibleAt: u.creatorProfile?.eligibleAt?.toISOString() ?? null,
      earlySignupCents: grantMap.get(u.id) ?? 0,
    })),
  };
}

/** Grant a one-time early-signup bonus as a real, immediately-payable
 *  CreatorEarning (no 7-day hold, no platform fee). Guarded to once per user. */
export async function grantEarlySignupBonus(opts: { actorId: string; userId: string; amountCents: number }) {
  const amountCents = Math.round(opts.amountCents);
  if (!Number.isFinite(amountCents) || amountCents < GRANT_MIN_CENTS || amountCents > GRANT_MAX_CENTS) {
    throw badRequest("Amount must be between $1 and $1,000");
  }

  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, username: true },
  });
  if (!user) throw notFound("User not found");

  const existing = await prisma.creatorEarning.findFirst({
    where: { creatorId: opts.userId, source: "grant" },
    select: { id: true },
  });
  if (existing) throw conflict("This user already received an early-signup grant");

  const earning = await prisma.creatorEarning.create({
    data: {
      creatorId: opts.userId,
      source: "grant",
      sourceId: "early_signup",
      grossCents: amountCents,
      processorFeeCents: 0,
      platformFeeCents: 0,
      netCents: amountCents,
      currency: "USD",
      status: "available",         // payable immediately — it's a grant, not held revenue
      availableAt: new Date(),
    },
    select: { id: true, netCents: true },
  });

  auditMod("mod_action_applied", {
    actorId: opts.actorId,
    targetUserId: opts.userId,
    targetType: "CreatorEarning",
    targetId: earning.id,
    action: "creator_bonus_grant",
    note: `early_signup $${(amountCents / 100).toFixed(2)}`,
  });

  return {
    user: { id: user.id, username: user.username },
    amountCents: earning.netCents,
  };
}

/** Grant (status="active") or revoke (status="none") manual Creator Studio access. */
export async function setCreatorGrant(opts: { actorId: string; userId: string; grant: boolean }) {
  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, username: true },
  });
  if (!user) throw notFound("User not found");

  const status: CreatorStatus = opts.grant ? "active" : "none";
  const profile = await prisma.creatorProfile.upsert({
    where: { userId: opts.userId },
    create: {
      userId: opts.userId,
      status,
      ...(opts.grant ? { isEligible: true, eligibleAt: new Date() } : {}),
    },
    update: {
      status,
      ...(opts.grant ? { isEligible: true, eligibleAt: new Date() } : {}),
    },
    select: { userId: true, status: true, isEligible: true, eligibleAt: true },
  });

  auditMod("mod_action_applied", {
    actorId: opts.actorId,
    targetUserId: opts.userId,
    targetType: "CreatorProfile",
    targetId: opts.userId,
    action: opts.grant ? "creator_grant" : "creator_revoke",
    note: null,
  });

  return {
    user: { id: user.id, username: user.username },
    status: profile.status as CreatorStatus,
    isStudioGranted: profile.status === "active",
  };
}
