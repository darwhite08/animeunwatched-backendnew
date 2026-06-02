import crypto from "node:crypto";
import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit } from "../../lib/adminAudit";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Update editable User fields. Validates that operator isn't editing themselves
 * out of a critical state (e.g. removing their own ADMIN role lives in setUserRole).
 */
export async function updateUser(opts: {
  actorId: string;
  userId:  string;
  patch:   { displayName?: string; bio?: string | null; reputation?: number };
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!user) throw notFound("User not found");

  const before = { displayName: user.displayName, bio: user.bio, reputation: user.reputation };
  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data: {
      ...(opts.patch.displayName !== undefined ? { displayName: opts.patch.displayName } : {}),
      ...(opts.patch.bio        !== undefined ? { bio:         opts.patch.bio }         : {}),
      ...(opts.patch.reputation !== undefined ? { reputation:  opts.patch.reputation }  : {}),
    },
    select: { id: true, username: true, displayName: true, bio: true, reputation: true },
  });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "user.update",
    targetType: "User",
    targetId:   opts.userId,
    metadata:   { before, after: { displayName: updated.displayName, bio: updated.bio, reputation: updated.reputation } },
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { user: updated };
}

/**
 * Generate a one-time password-reset token for a target user. Operator-driven;
 * the user does not need to be logged in. Token is returned ONCE so the operator
 * can deliver it (or the system emails it — left to email layer).
 */
export async function adminGeneratePasswordReset(opts: {
  actorId: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!user) throw notFound("User not found");

  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  await prisma.passwordResetToken.create({
    data: { userId: opts.userId, tokenHash, expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) },
  });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "user.password_reset_issued",
    targetType: "User",
    targetId:   opts.userId,
    metadata:   { expiresInSec: PASSWORD_RESET_TTL_MS / 1000 },
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { token: raw, expiresInSec: PASSWORD_RESET_TTL_MS / 1000, email: user.email };
}

/** Disable TOTP on a target account (operator emergency action). */
export async function adminResetMfa(opts: {
  actorId: string; userId: string;
  ipAddress?: string | null; userAgent?: string | null;
}) {
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!user) throw notFound("User not found");
  await prisma.totpSecret.deleteMany({ where: { userId: opts.userId } });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "user.mfa_reset",
    targetType: "User",
    targetId:   opts.userId,
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { ok: true };
}

/** Revoke all sessions for the target user (kicks them out of every device). */
export async function adminRevokeSessions(opts: {
  actorId: string; userId: string;
  ipAddress?: string | null; userAgent?: string | null;
}) {
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!user) throw notFound("User not found");
  const { count } = await prisma.refreshToken.deleteMany({ where: { userId: opts.userId } });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "user.sessions_revoked",
    targetType: "User",
    targetId:   opts.userId,
    metadata:   { revokedCount: count },
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { revokedCount: count };
}

/** List active refresh-token sessions for a user (admin view). */
export async function listUserSessions(userId: string) {
  const sessions = await prisma.refreshToken.findMany({
    where:   { userId, expiresAt: { gt: new Date() } },
    select:  { id: true, userAgent: true, ipAddress: true, lastUsedAt: true, expiresAt: true, createdAt: true },
    orderBy: { lastUsedAt: "desc" },
  });
  return { sessions };
}

/** Issue an admin invite — token is hashed in storage. */
export async function createInvite(opts: {
  actorId:  string;
  email:    string;
  roleName?: string;       // AdminRole.name to assign on accept (optional)
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const email = opts.email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("Invalid email");
  if (opts.roleName) {
    const role = await prisma.adminRole.findUnique({ where: { name: opts.roleName } });
    if (!role) throw badRequest(`Unknown role: ${opts.roleName}`);
  }
  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const invite = await prisma.userInvite.create({
    data: {
      email,
      tokenHash,
      inviterId: opts.actorId,
      roleName:  opts.roleName ?? null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    select: { id: true, email: true, roleName: true, expiresAt: true, createdAt: true },
  });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "invite.created",
    targetType: "UserInvite",
    targetId:   invite.id,
    metadata:   { email, roleName: opts.roleName ?? null },
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { invite, token: raw, expiresInSec: INVITE_TTL_MS / 1000 };
}

export async function listInvites(opts: { page: number; limit: number }) {
  const skip = (opts.page - 1) * opts.limit;
  const [data, total] = await prisma.$transaction([
    prisma.userInvite.findMany({
      where:   { acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      skip, take: opts.limit,
      select:  { id: true, email: true, roleName: true, expiresAt: true, createdAt: true, inviterId: true },
    }),
    prisma.userInvite.count({ where: { acceptedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  return { data, total, page: opts.page, limit: opts.limit };
}

export async function revokeInvite(opts: {
  actorId: string; inviteId: string;
  ipAddress?: string | null; userAgent?: string | null;
}) {
  const inv = await prisma.userInvite.findUnique({ where: { id: opts.inviteId } });
  if (!inv) throw notFound("Invite not found");
  if (inv.acceptedAt) throw badRequest("Invite already accepted");
  await prisma.userInvite.delete({ where: { id: opts.inviteId } });
  await adminAudit({
    actorId: opts.actorId, action: "invite.revoked",
    targetType: "UserInvite", targetId: opts.inviteId,
    ipAddress: opts.ipAddress, userAgent: opts.userAgent,
  });
  return { ok: true };
}

/**
 * Accept an invite. Public endpoint (invitee may not yet have an account).
 *   - If email matches an existing user → they're attached to the assigned role
 *   - Otherwise creates a new User with the supplied password
 */
export async function acceptInvite(opts: {
  rawToken: string;
  password: string;
  username?: string;
  displayName?: string;
}) {
  const tokenHash = crypto.createHash("sha256").update(opts.rawToken).digest("hex");
  const inv = await prisma.userInvite.findUnique({ where: { tokenHash } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
    throw badRequest("Invite invalid or expired");
  }

  // Find or create user
  let user = await prisma.user.findUnique({ where: { email: inv.email } });
  if (!user) {
    if (!opts.username || !opts.displayName) {
      throw badRequest("username and displayName required for new account");
    }
    if (!opts.password || opts.password.length < 8) {
      throw badRequest("password (8+ chars) required");
    }
    user = await prisma.user.create({
      data: {
        email:        inv.email,
        username:     opts.username,
        displayName:  opts.displayName,
        passwordHash: await argon2.hash(opts.password),
      },
    });
  }

  // Assign admin role if any
  if (inv.roleName) {
    const role = await prisma.adminRole.findUnique({ where: { name: inv.roleName } });
    if (role) {
      await prisma.userAdminRole.upsert({
        where:  { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id, grantedBy: inv.inviterId },
      });
    }
  }

  await prisma.userInvite.update({
    where: { id: inv.id },
    data:  { acceptedAt: new Date(), acceptedBy: user.id },
  });
  await adminAudit({
    actorId:    user.id,
    action:     "invite.accepted",
    targetType: "User",
    targetId:   user.id,
    metadata:   { roleName: inv.roleName, inviterId: inv.inviterId },
  });
  return { user: { id: user.id, email: user.email, username: user.username } };
}

/**
 * Bulk action over a list of user IDs. Supported actions: ban, unban,
 * revoke-sessions. Each per-user mutation is audited individually so the
 * trail captures who-affected-whom precisely.
 */
export async function bulkUserAction(opts: {
  actorId: string;
  userIds: string[];
  action: "ban" | "unban" | "revoke_sessions";
  reason?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  if (opts.userIds.length === 0) return { applied: 0, skipped: 0 };
  if (opts.userIds.length > 200) throw badRequest("max 200 users per bulk action");

  let applied = 0;
  let skipped = 0;
  for (const userId of opts.userIds) {
    if (userId === opts.actorId) { skipped++; continue; }
    try {
      if (opts.action === "ban") {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (!u || u.role === "ADMIN") { skipped++; continue; }
        await prisma.user.update({ where: { id: userId }, data: { isBanned: true, bannedReason: opts.reason ?? null } });
        await prisma.refreshToken.deleteMany({ where: { userId } });
      } else if (opts.action === "unban") {
        await prisma.user.update({ where: { id: userId }, data: { isBanned: false, bannedReason: null } });
      } else if (opts.action === "revoke_sessions") {
        await prisma.refreshToken.deleteMany({ where: { userId } });
      }
      await adminAudit({
        actorId:    opts.actorId,
        action:     `user.bulk.${opts.action}`,
        targetType: "User",
        targetId:   userId,
        metadata:   { reason: opts.reason ?? null },
        ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
      });
      applied++;
    } catch { skipped++; }
  }
  return { applied, skipped };
}

/** Soft-delete (anonymize) a user. Hard-delete is intentionally NOT exposed. */
export async function softDeleteUser(opts: {
  actorId: string; userId: string;
  ipAddress?: string | null; userAgent?: string | null;
}) {
  const u = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!u) throw notFound("User not found");
  if (u.role === "ADMIN") throw badRequest("Cannot delete another admin");

  const before = { email: u.email, displayName: u.displayName, isBanned: u.isBanned };
  await prisma.user.update({
    where: { id: opts.userId },
    data: {
      email:        `deleted+${u.id}@kaiveron.invalid`,
      displayName:  "[deleted]",
      bio:          null,
      avatarUrl:    null,
      isBanned:     true,
      bannedReason: "deleted",
      passwordHash: "",
    },
  });
  await prisma.refreshToken.deleteMany({ where: { userId: opts.userId } });
  await adminAudit({
    actorId:    opts.actorId,
    action:     "user.soft_delete",
    targetType: "User",
    targetId:   opts.userId,
    metadata:   { before },
    ipAddress:  opts.ipAddress, userAgent: opts.userAgent,
  });
  return { ok: true };
}
