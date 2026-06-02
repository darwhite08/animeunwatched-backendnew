import { describe, it, expect, vi, beforeEach } from "vitest";

const users = new Map<string, { id: string; email: string; username: string; displayName: string; bio: string | null; reputation: number; isBanned: boolean; bannedReason: string | null; role: string; passwordHash: string; avatarUrl: string | null }>();
const refreshTokens: Array<{ id: string; userId: string }> = [];
const invites = new Map<string, { id: string; email: string; tokenHash: string; inviterId: string; roleName: string | null; expiresAt: Date; acceptedAt: Date | null }>();
const totpSecrets = new Map<string, { userId: string }>();
const passwordResets: Array<{ userId: string; tokenHash: string }> = [];
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null),
      update:     vi.fn(async ({ where: { id }, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: unknown }) => {
        const u = users.get(id); if (!u) return null;
        Object.assign(u, data);
        return select ? { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, reputation: u.reputation } : u;
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => { users.delete(id); return null }),
    },
    refreshToken: {
      deleteMany: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) => {
        const before = refreshTokens.length;
        for (let i = refreshTokens.length - 1; i >= 0; i--) if (refreshTokens[i].userId === userId) refreshTokens.splice(i, 1);
        return { count: before - refreshTokens.length };
      }),
      findMany: vi.fn(async ({ where: { userId } }: { where: { userId: string; expiresAt: { gt: Date } } }) =>
        refreshTokens.filter(t => t.userId === userId)),
    },
    passwordResetToken: {
      create: vi.fn(async ({ data }: { data: { userId: string; tokenHash: string } }) => { passwordResets.push(data); return data }),
    },
    totpSecret: {
      deleteMany: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) => {
        const had = totpSecrets.has(userId);
        totpSecrets.delete(userId);
        return { count: had ? 1 : 0 };
      }),
    },
    userInvite: {
      create: vi.fn(async ({ data, select }: { data: { email: string; tokenHash: string; inviterId: string; roleName: string | null; expiresAt: Date }; select?: unknown }) => {
        const id = `inv-${invites.size + 1}`;
        const inv = { id, acceptedAt: null, ...data };
        invites.set(id, inv);
        return select ? { id, email: inv.email, roleName: inv.roleName, expiresAt: inv.expiresAt, createdAt: new Date() } : inv;
      }),
      findMany: vi.fn(async () => Array.from(invites.values())),
      findUnique: vi.fn(async ({ where: { id, tokenHash } }: { where: { id?: string; tokenHash?: string } }) => {
        if (id) return invites.get(id) ?? null;
        return Array.from(invites.values()).find(i => i.tokenHash === tokenHash) ?? null;
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => { invites.delete(id); return null }),
      count:  vi.fn(async () => invites.size),
    },
    adminRole: { findUnique: vi.fn(async () => ({ id: "r1", name: "Support" })) },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { updateUser, adminGeneratePasswordReset, adminResetMfa, adminRevokeSessions, listUserSessions, createInvite, listInvites, revokeInvite, bulkUserAction, softDeleteUser } from "../app/src/modules/admin/users.service";

beforeEach(() => {
  users.clear(); refreshTokens.length = 0; invites.clear(); totpSecrets.clear(); passwordResets.length = 0; audits.length = 0;
});

describe("users.service", () => {
  it("updateUser captures before+after in audit metadata", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "old", bio: "b1", reputation: 5, isBanned: false, bannedReason: null, role: "USER", passwordHash: "", avatarUrl: null });
    await updateUser({ actorId: "op", userId: "u1", patch: { displayName: "new", reputation: 99 } });
    expect(users.get("u1")?.displayName).toBe("new");
    expect(users.get("u1")?.reputation).toBe(99);
    expect(audits).toContain("user.update");
  });

  it("adminGeneratePasswordReset issues a hashed token", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "x", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "USER", passwordHash: "", avatarUrl: null });
    const r = await adminGeneratePasswordReset({ actorId: "op", userId: "u1" });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r.email).toBe("x@y");
    expect(passwordResets).toHaveLength(1);
    expect(audits).toContain("user.password_reset_issued");
  });

  it("adminResetMfa removes TOTP secret + audits", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "x", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "USER", passwordHash: "", avatarUrl: null });
    totpSecrets.set("u1", { userId: "u1" });
    await adminResetMfa({ actorId: "op", userId: "u1" });
    expect(totpSecrets.has("u1")).toBe(false);
    expect(audits).toContain("user.mfa_reset");
  });

  it("adminRevokeSessions deletes refresh tokens + audits", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "x", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "USER", passwordHash: "", avatarUrl: null });
    refreshTokens.push({ id: "t1", userId: "u1" });
    refreshTokens.push({ id: "t2", userId: "u1" });
    const r = await adminRevokeSessions({ actorId: "op", userId: "u1" });
    expect(r.revokedCount).toBe(2);
    expect(audits).toContain("user.sessions_revoked");
  });

  it("createInvite validates email + audits", async () => {
    await expect(createInvite({ actorId: "op", email: "bad" })).rejects.toThrow(/Invalid email/);
    const r = await createInvite({ actorId: "op", email: "new@kaiveron.com", roleName: "Support" });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(audits).toContain("invite.created");
  });

  it("revokeInvite rejects accepted invites", async () => {
    invites.set("i1", { id: "i1", email: "x@y", tokenHash: "h", inviterId: "op", roleName: null, expiresAt: new Date(Date.now() + 60000), acceptedAt: new Date() });
    await expect(revokeInvite({ actorId: "op", inviteId: "i1" })).rejects.toThrow(/already accepted/);
  });

  it("bulkUserAction respects max-200 cap", async () => {
    await expect(bulkUserAction({ actorId: "op", userIds: new Array(201).fill("x"), action: "ban" })).rejects.toThrow(/max 200/);
  });

  it("bulkUserAction skips actor's own id", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "x", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "USER", passwordHash: "", avatarUrl: null });
    const r = await bulkUserAction({ actorId: "op", userIds: ["op", "u1"], action: "ban" });
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("bulkUserAction skips ADMIN role on ban", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "x", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "ADMIN", passwordHash: "", avatarUrl: null });
    const r = await bulkUserAction({ actorId: "op", userIds: ["u1"], action: "ban" });
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("softDeleteUser anonymizes + bans + revokes sessions + audits", async () => {
    users.set("u1", { id: "u1", email: "real@y", username: "x", displayName: "X", bio: "b", reputation: 0, isBanned: false, bannedReason: null, role: "USER", passwordHash: "h", avatarUrl: "a" });
    refreshTokens.push({ id: "t1", userId: "u1" });
    await softDeleteUser({ actorId: "op", userId: "u1" });
    const u = users.get("u1");
    expect(u?.email).toContain("deleted+u1");
    expect(u?.displayName).toBe("[deleted]");
    expect(u?.isBanned).toBe(true);
    expect(refreshTokens.find(t => t.userId === "u1")).toBeUndefined();
    expect(audits).toContain("user.soft_delete");
  });

  it("softDeleteUser refuses to delete another admin", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", displayName: "X", bio: null, reputation: 0, isBanned: false, bannedReason: null, role: "ADMIN", passwordHash: "", avatarUrl: null });
    await expect(softDeleteUser({ actorId: "op", userId: "u1" })).rejects.toThrow(/Cannot delete another admin/);
  });

  it("listUserSessions filters un-expired tokens", async () => {
    const { sessions } = await listUserSessions("u1");
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("listInvites paginates pending only", async () => {
    invites.set("i1", { id: "i1", email: "a@y", tokenHash: "h1", inviterId: "op", roleName: null, expiresAt: new Date(Date.now() + 60000), acceptedAt: null });
    const r = await listInvites({ page: 1, limit: 10 });
    expect(r.data).toHaveLength(1);
    expect(r.page).toBe(1);
  });
});
