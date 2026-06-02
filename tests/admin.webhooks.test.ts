import { describe, it, expect, vi, beforeEach } from "vitest";

const endpoints  = new Map<string, { id: string; url: string; events: string[]; enabled: boolean; secret: string; description: string | null }>();
const deliveries = new Map<string, { id: string; endpointId: string; eventName: string; eventId: string; payload: unknown; attempts: number; succeededAt: Date | null; responseStatus: number | null }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    webhookEndpoint: {
      findMany:   vi.fn(async () => Array.from(endpoints.values())),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => endpoints.get(id) ?? null),
      create:     vi.fn(async ({ data }: { data: { url: string; events: string[]; secret: string; description: string | null } }) => {
        const ep = { id: `e-${endpoints.size + 1}`, enabled: true, ...data };
        endpoints.set(ep.id, ep); return ep;
      }),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const ep = endpoints.get(id); if (!ep) return null;
        Object.assign(ep, data); return ep;
      }),
      delete:     vi.fn(async ({ where: { id } }: { where: { id: string } }) => { endpoints.delete(id); return null }),
    },
    webhookDelivery: {
      findMany: vi.fn(async () => Array.from(deliveries.values())),
      count:    vi.fn(async () => deliveries.size),
      findUnique: vi.fn(async ({ where: { id }, include }: { where: { id: string }; include?: unknown }) => {
        const d = deliveries.get(id); if (!d) return null;
        if (include) return { ...d, flag: null };
        return d;
      }),
      create:   vi.fn(async ({ data }: { data: { endpointId: string; eventName: string; eventId: string; payload: unknown; attempts: number } }) => {
        const d = { id: `d-${deliveries.size + 1}`, succeededAt: null, responseStatus: null, ...data };
        deliveries.set(d.id, d); return d;
      }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, listDeliveries, replayDelivery } from "../app/src/modules/admin/webhooks.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { endpoints.clear(); deliveries.clear(); audits.length = 0 });

describe("webhooks controller", () => {
  it("createEndpoint rejects bad URL", async () => {
    const next = vi.fn();
    await createEndpoint(makeReq({ url: "not-a-url", events: ["x"] }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/url/);
  });

  it("createEndpoint rejects empty events[]", async () => {
    const next = vi.fn();
    await createEndpoint(makeReq({ url: "https://x.com", events: [] }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/events/);
  });

  it("createEndpoint returns secret ONCE", async () => {
    const res = makeRes();
    await createEndpoint(makeReq({ url: "https://x.com/wh", events: ["user.created"] }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(call.endpoint.url).toBe("https://x.com/wh");
    expect(audits).toContain("webhook.create");
  });

  it("updateEndpoint toggles enabled + audits", async () => {
    endpoints.set("e1", { id: "e1", url: "https://x.com", events: ["x"], enabled: true, secret: "s", description: null });
    await updateEndpoint(makeReq({ enabled: false }, { endpointId: "e1" }), makeRes(), vi.fn() as never);
    expect(endpoints.get("e1")?.enabled).toBe(false);
    expect(audits).toContain("webhook.update");
  });

  it("deleteEndpoint removes row + audits", async () => {
    endpoints.set("e1", { id: "e1", url: "https://x.com", events: ["x"], enabled: true, secret: "s", description: null });
    await deleteEndpoint(makeReq({}, { endpointId: "e1" }), makeRes(), vi.fn() as never);
    expect(endpoints.size).toBe(0);
    expect(audits).toContain("webhook.delete");
  });

  it("replayDelivery creates a new delivery with attempts=0 + audits", async () => {
    deliveries.set("d1", { id: "d1", endpointId: "e1", eventName: "user.created", eventId: "ev-1", payload: { x: 1 }, attempts: 3, succeededAt: null, responseStatus: 500 });
    await replayDelivery(makeReq({}, { deliveryId: "d1" }), makeRes(), vi.fn() as never);
    expect(deliveries.size).toBe(2);
    const replay = Array.from(deliveries.values())[1];
    expect(replay.attempts).toBe(0);
    expect(replay.eventId).toBe("ev-1");
    expect(audits).toContain("webhook.replay");
  });

  it("listDeliveries failed-only filter", async () => {
    deliveries.set("d1", { id: "d1", endpointId: "e1", eventName: "x", eventId: "1", payload: {}, attempts: 1, succeededAt: new Date(), responseStatus: 200 });
    deliveries.set("d2", { id: "d2", endpointId: "e1", eventName: "x", eventId: "2", payload: {}, attempts: 3, succeededAt: null,         responseStatus: 500 });
    const res = makeRes();
    await listDeliveries(makeReq({}, {}, { failed: "true" }), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toBeDefined();
  });

  it("listEndpoints returns array", async () => {
    endpoints.set("e1", { id: "e1", url: "https://x.com", events: ["x"], enabled: true, secret: "s", description: null });
    const res = makeRes();
    await listEndpoints(makeReq(), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
  });
});
