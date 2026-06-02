import { describe, it, expect, vi, beforeEach } from "vitest";

const anns = new Map<string, { id: string; title: string; body: string; audience: string; channel: string; scheduledAt: Date | null; publishedAt: Date | null; expiresAt: Date | null; createdAt: Date }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    announcement: {
      findMany:   vi.fn(async () => Array.from(anns.values())),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => anns.get(id) ?? null),
      create:     vi.fn(async ({ data }: { data: { title: string; body: string; audience: string; channel: string; scheduledAt: Date | null; expiresAt: Date | null; publishedAt: Date | null } }) => {
        const a = { id: `a-${anns.size + 1}`, createdAt: new Date(), ...data };
        anns.set(a.id, a); return a;
      }),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const a = anns.get(id); if (!a) return null;
        Object.assign(a, data); return a;
      }),
      delete:     vi.fn(async ({ where: { id } }: { where: { id: string } }) => { anns.delete(id); return null }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

import { listAnnouncements, createAnnouncement, publishAnnouncement, deleteAnnouncement, activeAnnouncements } from "../app/src/modules/admin/announcements.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return { body, params, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { anns.clear(); audits.length = 0 });

describe("announcements controller", () => {
  it("createAnnouncement requires title + body", async () => {
    const next = vi.fn();
    await createAnnouncement(makeReq({ title: "x" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/required/);
  });

  it("createAnnouncement draft (no publish) sets publishedAt=null + emits .create", async () => {
    await createAnnouncement(makeReq({ title: "T", body: "B" }), makeRes(), vi.fn() as never);
    const a = Array.from(anns.values())[0];
    expect(a.publishedAt).toBeNull();
    expect(audits).toContain("announcement.create");
  });

  it("createAnnouncement publish=true sets publishedAt + emits .publish", async () => {
    await createAnnouncement(makeReq({ title: "T", body: "B", publish: true }), makeRes(), vi.fn() as never);
    const a = Array.from(anns.values())[0];
    expect(a.publishedAt).toBeInstanceOf(Date);
    expect(audits).toContain("announcement.publish");
  });

  it("publishAnnouncement sets publishedAt + audits", async () => {
    anns.set("a1", { id: "a1", title: "T", body: "B", audience: "all", channel: "in_app", scheduledAt: null, publishedAt: null, expiresAt: null, createdAt: new Date() });
    await publishAnnouncement(makeReq({}, { id: "a1" }), makeRes(), vi.fn() as never);
    expect(anns.get("a1")?.publishedAt).toBeInstanceOf(Date);
    expect(audits).toContain("announcement.publish");
  });

  it("deleteAnnouncement removes + audits", async () => {
    anns.set("a1", { id: "a1", title: "T", body: "B", audience: "all", channel: "in_app", scheduledAt: null, publishedAt: null, expiresAt: null, createdAt: new Date() });
    await deleteAnnouncement(makeReq({}, { id: "a1" }), makeRes(), vi.fn() as never);
    expect(anns.size).toBe(0);
    expect(audits).toContain("announcement.delete");
  });

  it("listAnnouncements + activeAnnouncements shape", async () => {
    const res1 = makeRes(); await listAnnouncements(makeReq(), res1, vi.fn() as never);
    expect((res1.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toBeDefined();
    const res2 = makeRes(); await activeAnnouncements(makeReq(), res2, vi.fn() as never);
    expect((res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toBeDefined();
  });
});
