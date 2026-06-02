import { describe, it, expect, vi, beforeEach } from "vitest";

const posts = new Map<string, { id: string; content: string; authorId: string; deletedAt: Date | null }>();
const clubs = new Map<string, { id: string; name: string; slug: string; ownerId: string }>();
const users = new Map<string, { id: string; role: string; isShadowBanned: boolean }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    post: {
      findMany: vi.fn(async () => Array.from(posts.values())),
      count:    vi.fn(async () => posts.size),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => posts.get(id) ?? null),
      update:   vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = posts.get(id); if (!p) return null;
        Object.assign(p, data); return p;
      }),
    },
    club: {
      findMany: vi.fn(async () => Array.from(clubs.values())),
      count:    vi.fn(async () => clubs.size),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => clubs.get(id) ?? null),
      delete:   vi.fn(async ({ where: { id } }: { where: { id: string } }) => { clubs.delete(id); return null }),
    },
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.get(id); if (!u) return null;
        Object.assign(u, data); return u;
      }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { listPosts, deletePost, shadowBanUser, unshadowBanUser, listClubs, deleteClub } from "../app/src/modules/admin/content.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { posts.clear(); clubs.clear(); users.clear(); audits.length = 0 });

describe("content controller", () => {
  it("deletePost soft-deletes + audits", async () => {
    posts.set("p1", { id: "p1", content: "hello", authorId: "u1", deletedAt: null });
    await deletePost(makeReq({}, { postId: "p1" }), makeRes(), vi.fn() as never);
    expect(posts.get("p1")?.deletedAt).toBeInstanceOf(Date);
    expect(audits).toContain("post.delete");
  });

  it("deletePost returns notFound for missing post", async () => {
    const next = vi.fn();
    await deletePost(makeReq({}, { postId: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });

  it("shadowBanUser refuses admins", async () => {
    users.set("u1", { id: "u1", role: "ADMIN", isShadowBanned: false });
    const next = vi.fn();
    await shadowBanUser(makeReq({ reason: "x" }, { userId: "u1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/admin/);
  });

  it("shadowBanUser sets isShadowBanned + audits", async () => {
    users.set("u1", { id: "u1", role: "USER", isShadowBanned: false });
    await shadowBanUser(makeReq({ reason: "spam" }, { userId: "u1" }), makeRes(), vi.fn() as never);
    expect(users.get("u1")?.isShadowBanned).toBe(true);
    expect(audits).toContain("user.shadow_ban");
  });

  it("unshadowBanUser clears flag + audits", async () => {
    users.set("u1", { id: "u1", role: "USER", isShadowBanned: true });
    await unshadowBanUser(makeReq({}, { userId: "u1" }), makeRes(), vi.fn() as never);
    expect(users.get("u1")?.isShadowBanned).toBe(false);
    expect(audits).toContain("user.shadow_unban");
  });

  it("deleteClub removes + audits", async () => {
    clubs.set("c1", { id: "c1", name: "Anime fans", slug: "anime-fans", ownerId: "u1" });
    await deleteClub(makeReq({}, { clubId: "c1" }), makeRes(), vi.fn() as never);
    expect(clubs.size).toBe(0);
    expect(audits).toContain("club.delete");
  });

  it("listPosts + listClubs return paginated shape", async () => {
    posts.set("p1", { id: "p1", content: "x", authorId: "u1", deletedAt: null });
    clubs.set("c1", { id: "c1", name: "X", slug: "x", ownerId: "u1" });
    const r1 = makeRes(); await listPosts(makeReq(), r1, vi.fn() as never);
    expect((r1.json as ReturnType<typeof vi.fn>).mock.calls[0][0].total).toBe(1);
    const r2 = makeRes(); await listClubs(makeReq(), r2, vi.fn() as never);
    expect((r2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].total).toBe(1);
  });
});
