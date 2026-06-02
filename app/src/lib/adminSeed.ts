import { prisma } from "../config/prisma";

/**
 * Idempotent seed of default admin permissions + roles.
 * Called once at app boot from server.ts.
 *
 *   SuperAdmin    — wildcard (all permissions; granted by name match in permissions.ts)
 *   Support       — read-only over users + tenants, can reset passwords/MFA, view audit
 *   BillingAdmin  — billing + entitlements, refund up to defined cap (enforced in module)
 *   Moderator     — moderation queue + content actions
 *   ReadOnlyAdmin — read everything, mutate nothing
 *
 * Any existing User.role=ADMIN is auto-granted SuperAdmin if they have no admin roles
 * yet — keeps the bootstrap admin (you) functional after the schema change.
 */

const PERMISSIONS = [
  ["users",        "read"],
  ["users",        "create"],
  ["users",        "update"],
  ["users",        "suspend"],
  ["users",        "delete"],
  ["users",        "reset_password"],
  ["users",        "reset_mfa"],
  ["users",        "revoke_sessions"],
  ["users",        "role"],

  ["roles",        "read"],
  ["roles",        "write"],

  ["audit",        "read"],
  ["audit",        "export"],

  ["moderation",   "read"],
  ["moderation",   "act"],

  ["billing",      "read"],
  ["billing",      "refund"],
  ["billing",      "credit"],

  ["flags",        "read"],
  ["flags",        "write"],
  ["flags",        "kill"],

  ["entitlements", "read"],
  ["entitlements", "write"],

  ["impersonation","start"],

  ["api_keys",     "read"],
  ["api_keys",     "write"],

  ["webhooks",     "read"],
  ["webhooks",     "write"],
  ["webhooks",     "replay"],

  ["security",     "read"],
  ["security",     "write"],

  ["dsr",          "export"],
  ["dsr",          "delete"],

  ["settings",     "read"],
  ["settings",     "write"],
] as const;

const ROLES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  SuperAdmin:    [],  // wildcard handled in permissions.ts
  Support: [
    ["users","read"], ["users","reset_password"], ["users","reset_mfa"], ["users","revoke_sessions"],
    ["audit","read"], ["moderation","read"], ["billing","read"], ["entitlements","read"],
    ["flags","read"], ["api_keys","read"], ["webhooks","read"], ["security","read"], ["settings","read"],
    ["roles","read"],
  ],
  BillingAdmin: [
    ["users","read"], ["billing","read"], ["billing","refund"], ["billing","credit"],
    ["entitlements","read"], ["entitlements","write"], ["audit","read"], ["settings","read"],
  ],
  Moderator: [
    ["users","read"], ["users","suspend"], ["moderation","read"], ["moderation","act"],
    ["audit","read"], ["settings","read"],
  ],
  ReadOnlyAdmin: [
    ["users","read"], ["roles","read"], ["audit","read"], ["moderation","read"],
    ["billing","read"], ["flags","read"], ["entitlements","read"], ["api_keys","read"],
    ["webhooks","read"], ["security","read"], ["settings","read"],
  ],
};

export async function ensureAdminSeed(): Promise<void> {
  // 1. Permissions
  for (const [resource, action] of PERMISSIONS) {
    await prisma.permission.upsert({
      where:  { resource_action: { resource, action } },
      update: {},
      create: { resource, action },
    });
  }

  const allPerms = await prisma.permission.findMany();
  const permId = (r: string, a: string): string => {
    const p = allPerms.find(x => x.resource === r && x.action === a);
    if (!p) throw new Error(`permission ${r}:${a} missing after seed`);
    return p.id;
  };

  // 2. Roles + role-permission mappings
  for (const [name, pairs] of Object.entries(ROLES)) {
    const role = await prisma.adminRole.upsert({
      where:  { name },
      update: { isSystem: true },
      create: { name, isSystem: true, description: name },
    });
    if (pairs.length === 0) continue;
    for (const [r, a] of pairs) {
      await prisma.rolePermission.upsert({
        where:  { roleId_permissionId: { roleId: role.id, permissionId: permId(r, a) } },
        update: {},
        create: { roleId: role.id, permissionId: permId(r, a) },
      });
    }
  }

  // 3. Bootstrap: every legacy User.role=ADMIN gets SuperAdmin if they have none.
  const sa = await prisma.adminRole.findUnique({ where: { name: "SuperAdmin" } });
  if (sa) {
    const legacyAdmins = await prisma.user.findMany({
      where:  { role: "ADMIN" },
      select: { id: true },
    });
    for (const u of legacyAdmins) {
      const existing = await prisma.userAdminRole.findFirst({ where: { userId: u.id } });
      if (existing) continue;
      await prisma.userAdminRole.create({
        data: { userId: u.id, roleId: sa.id, grantedBy: null },
      });
    }
  }
}
