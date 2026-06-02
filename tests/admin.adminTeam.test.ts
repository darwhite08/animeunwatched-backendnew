import { describe, it, expect, vi, beforeEach } from "vitest";

const userAdminRoles = [
  { userId: "u1", role: { name: "SuperAdmin" } },
  { userId: "u2", role: { name: "Moderator" } },
];
const legacyAdmins = [
  { id: "u1", email: "alice@k", username: "alice", displayName: "A", avatarUrl: null, isBanned: false, lastActiveAt: null, createdAt: new Date() },
];
const extras = [
  { id: "u2", email: "bob@k", username: "bob", displayName: "B", avatarUrl: null, isBanned: false, lastActiveAt: null, createdAt: new Date() },
];
let reviews: Record<string, string> | null = null;

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    userAdminRole: {
      findMany: vi.fn(async () => userAdminRoles),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { role?: string; id?: { in: string[] } } }) => {
        if (where.role === "ADMIN") return legacyAdmins;
        if (where.id?.in) return extras.filter(u => where.id!.in!.includes(u.id));
        return [];
      }),
    },
    adminSetting: {
      findUnique: vi.fn(async () => reviews ? { value: reviews } : null),
      upsert:     vi.fn(async ({ create }: { create: { value: unknown } }) => { reviews = create.value as Record<string, string>; return { value: create.value } }),
    },
  },
}));

import { listAdminTeam, markReviewed } from "../app/src/modules/admin/adminTeam.controller";

function makeReq(params: Record<string, string> = {}) {
  return { body: {}, params, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { reviews = null });

describe("admin team controller", () => {
  it("listAdminTeam merges legacyAdmins + extras + roles + reviews", async () => {
    reviews = { u1: "2026-05-01T00:00:00Z" };
    const res = makeRes();
    await listAdminTeam(makeReq(), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toHaveLength(2);
    const alice = data.find((u: { username: string }) => u.username === "alice");
    const bob   = data.find((u: { username: string }) => u.username === "bob");
    expect(alice.adminRoles).toContain("SuperAdmin");
    expect(alice.lastReviewAt).toBe("2026-05-01T00:00:00Z");
    expect(bob.adminRoles).toContain("Moderator");
  });

  it("markReviewed updates per-user timestamp in setting", async () => {
    const res = makeRes();
    await markReviewed(makeReq({ userId: "u1" }), res, vi.fn() as never);
    expect(reviews?.u1).toMatch(/T/);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.ok).toBe(true);
  });

  it("markReviewed preserves prior reviews", async () => {
    reviews = { u2: "2026-01-01T00:00:00Z" };
    await markReviewed(makeReq({ userId: "u1" }), makeRes(), vi.fn() as never);
    expect(reviews?.u2).toBe("2026-01-01T00:00:00Z");
    expect(reviews?.u1).toBeDefined();
  });
});
