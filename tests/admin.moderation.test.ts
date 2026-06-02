import { describe, it, expect, vi, beforeEach } from "vitest";

const items = new Map<string, { id: string; targetType: string; targetId: string; reason: string; source: string; status: string; reviewerId: string | null; reviewedAt: Date | null; reviewNote: string | null }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    moderationItem: {
      findMany:   vi.fn(async ({ where }: { where: { status?: string } }) => {
        let result = Array.from(items.values());
        if (where.status) result = result.filter(i => i.status === where.status);
        return result;
      }),
      count:      vi.fn(async ({ where }: { where: { status?: string } }) => {
        let result = Array.from(items.values());
        if (where.status) result = result.filter(i => i.status === where.status);
        return result.length;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => items.get(id) ?? null),
      create:     vi.fn(async ({ data }: { data: { targetType: string; targetId: string; reason: string; source: string } }) => {
        const item = { id: `m-${items.size + 1}`, status: "PENDING", reviewerId: null, reviewedAt: null, reviewNote: null, ...data };
        items.set(item.id, item); return item;
      }),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const i = items.get(id); if (!i) return null;
        Object.assign(i, data); return i;
      }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { listQueue, createQueueItem, reviewQueueItem } from "../app/src/modules/admin/moderationQueue.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { items.clear(); audits.length = 0 });

describe("moderation queue", () => {
  it("createQueueItem requires fields", async () => {
    const next = vi.fn();
    await createQueueItem(makeReq({ targetId: "x" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/required/);
  });

  it("createQueueItem defaults source=manual + status=PENDING + audits", async () => {
    await createQueueItem(makeReq({ targetType: "Post", targetId: "p1", reason: "spam" }), makeRes(), vi.fn() as never);
    const item = Array.from(items.values())[0];
    expect(item.source).toBe("manual");
    expect(item.status).toBe("PENDING");
    expect(audits).toContain("moderation.enqueue");
  });

  it("reviewQueueItem rejects invalid status", async () => {
    items.set("m1", { id: "m1", targetType: "Post", targetId: "p1", reason: "x", source: "manual", status: "PENDING", reviewerId: null, reviewedAt: null, reviewNote: null });
    const next = vi.fn();
    await reviewQueueItem(makeReq({ status: "WHATEVER" }, { id: "m1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/APPROVED|REJECTED|REMOVED/);
  });

  it("reviewQueueItem APPROVED transitions + audits with lower-cased action", async () => {
    items.set("m1", { id: "m1", targetType: "Post", targetId: "p1", reason: "x", source: "manual", status: "PENDING", reviewerId: null, reviewedAt: null, reviewNote: null });
    await reviewQueueItem(makeReq({ status: "APPROVED", note: "looks ok" }, { id: "m1" }), makeRes(), vi.fn() as never);
    expect(items.get("m1")?.status).toBe("APPROVED");
    expect(items.get("m1")?.reviewerId).toBe("op-1");
    expect(items.get("m1")?.reviewNote).toBe("looks ok");
    expect(audits).toContain("moderation.approved");
  });

  it("reviewQueueItem REJECTED transitions", async () => {
    items.set("m1", { id: "m1", targetType: "Post", targetId: "p1", reason: "x", source: "manual", status: "PENDING", reviewerId: null, reviewedAt: null, reviewNote: null });
    await reviewQueueItem(makeReq({ status: "REJECTED" }, { id: "m1" }), makeRes(), vi.fn() as never);
    expect(audits).toContain("moderation.rejected");
  });

  it("reviewQueueItem rejects already-reviewed items", async () => {
    items.set("m1", { id: "m1", targetType: "Post", targetId: "p1", reason: "x", source: "manual", status: "APPROVED", reviewerId: "x", reviewedAt: new Date(), reviewNote: null });
    const next = vi.fn();
    await reviewQueueItem(makeReq({ status: "REJECTED" }, { id: "m1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/already reviewed/);
  });

  it("listQueue filters by status", async () => {
    items.set("m1", { id: "m1", targetType: "Post", targetId: "p1", reason: "x", source: "manual", status: "PENDING",  reviewerId: null, reviewedAt: null, reviewNote: null });
    items.set("m2", { id: "m2", targetType: "Post", targetId: "p2", reason: "y", source: "manual", status: "APPROVED", reviewerId: "x", reviewedAt: new Date(), reviewNote: null });
    const res = makeRes();
    await listQueue(makeReq({}, {}, { status: "PENDING" }), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.every((d: { status: string }) => d.status === "PENDING")).toBe(true);
  });
});
