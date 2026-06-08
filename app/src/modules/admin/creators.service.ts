import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import { auditMod } from "../../lib/audit";

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
    })),
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
