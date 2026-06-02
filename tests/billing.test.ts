import { describe, it, expect, vi, beforeEach } from "vitest";

const plans = new Map<string, { id: string; key: string; providerPriceId: string | null }>();
const subs  = new Map<string, { id: string; planId: string; providerSubId: string | null; status: string; trialEndsAt: Date | null; cancelAtPeriodEnd: boolean; canceledAt: Date | null }>();
const invoices = new Map<string, { id: string; subscriptionId: string; amountCents: number; refundedAmount: number; status: string; refundedAt: Date | null; refundReason: string | null; providerInvoiceId: string | null }>();
const audits: Array<{ action: string }> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    plan: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => plans.get(id) ?? null),
    },
    subscription: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => subs.get(id) ?? null),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const cur = subs.get(id);
        if (!cur) return null;
        Object.assign(cur, data);
        return cur;
      }),
    },
    invoice: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => invoices.get(id) ?? null),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const cur = invoices.get(id); if (!cur) return null;
        Object.assign(cur, data); return cur;
      }),
      create:     vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `inv-${invoices.size + 1}`;
        const row = { id, refundedAmount: 0, refundedAt: null, refundReason: null, providerInvoiceId: null, status: "PAID", ...data } as typeof invoices extends Map<string, infer V> ? V : never;
        invoices.set(id, row); return row;
      }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push({ action: data.action }); return data }),
    },
  },
}));

import { changePlan, refundInvoice, creditSubscription, extendTrial, cancelSubscription } from "../app/src/modules/admin/billing.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return { body, params, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  const res: Record<string, unknown> = {
    locals: { user: { id: "operator-1" } },
    status: vi.fn().mockImplementation(() => res),
    json:   vi.fn().mockImplementation(() => res),
  };
  return res as never;
}

beforeEach(() => {
  plans.clear(); subs.clear(); invoices.clear(); audits.length = 0;
});

describe("billing", () => {
  it("changePlan updates planId and writes audit", async () => {
    plans.set("p1", { id: "p1", key: "free", providerPriceId: null });
    plans.set("p2", { id: "p2", key: "pro",  providerPriceId: "price_pro" });
    subs.set("s1",  { id: "s1", planId: "p1", providerSubId: null, status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: null });

    const res = makeRes();
    await changePlan(makeReq({ planId: "p2" }, { id: "s1" }), res, vi.fn() as never);
    expect(subs.get("s1")?.planId).toBe("p2");
    expect(audits.find(a => a.action === "billing.change_plan")).toBeDefined();
  });

  it("refundInvoice rejects when already fully refunded", async () => {
    invoices.set("i1", { id: "i1", subscriptionId: "s1", amountCents: 1000, refundedAmount: 1000, status: "REFUNDED", refundedAt: null, refundReason: null, providerInvoiceId: null });
    const next = vi.fn();
    await refundInvoice(makeReq({ amountCents: 100 }, { id: "i1" }), makeRes(), next as never);
    expect(next).toHaveBeenCalled();
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Already refunded/);
  });

  it("refundInvoice partial → status stays OPEN, refundedAmount accumulates", async () => {
    invoices.set("i1", { id: "i1", subscriptionId: "s1", amountCents: 1000, refundedAmount: 0, status: "PAID", refundedAt: null, refundReason: null, providerInvoiceId: null });
    await refundInvoice(makeReq({ amountCents: 300 }, { id: "i1" }), makeRes(), vi.fn() as never);
    expect(invoices.get("i1")?.refundedAmount).toBe(300);
    expect(invoices.get("i1")?.status).toBe("PAID");
  });

  it("refundInvoice full → status becomes REFUNDED", async () => {
    invoices.set("i1", { id: "i1", subscriptionId: "s1", amountCents: 1000, refundedAmount: 0, status: "PAID", refundedAt: null, refundReason: null, providerInvoiceId: null });
    await refundInvoice(makeReq({ amountCents: 1000 }, { id: "i1" }), makeRes(), vi.fn() as never);
    expect(invoices.get("i1")?.status).toBe("REFUNDED");
  });

  it("creditSubscription creates a negative-amount PAID invoice", async () => {
    subs.set("s1", { id: "s1", planId: "p1", providerSubId: null, status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: null });
    await creditSubscription(makeReq({ amountCents: 500, reason: "goodwill" }, { id: "s1" }), makeRes(), vi.fn() as never);
    const inv = Array.from(invoices.values())[0];
    expect(inv.amountCents).toBe(-500);
    expect(inv.status).toBe("PAID");
  });

  it("extendTrial extends trialEndsAt by N days", async () => {
    const original = new Date("2026-01-01T00:00:00Z");
    subs.set("s1", { id: "s1", planId: "p1", providerSubId: null, status: "ACTIVE", trialEndsAt: original, cancelAtPeriodEnd: false, canceledAt: null });
    await extendTrial(makeReq({ days: 7 }, { id: "s1" }), makeRes(), vi.fn() as never);
    const newEnd = subs.get("s1")?.trialEndsAt;
    expect(newEnd?.toISOString()).toBe(new Date(original.getTime() + 7 * 86_400_000).toISOString());
    expect(subs.get("s1")?.status).toBe("TRIALING");
  });

  it("cancelSubscription with atPeriodEnd sets cancelAtPeriodEnd flag", async () => {
    subs.set("s1", { id: "s1", planId: "p1", providerSubId: null, status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: null });
    await cancelSubscription(makeReq({ atPeriodEnd: true }, { id: "s1" }), makeRes(), vi.fn() as never);
    expect(subs.get("s1")?.cancelAtPeriodEnd).toBe(true);
    expect(subs.get("s1")?.status).toBe("ACTIVE");
  });

  it("cancelSubscription immediate sets status=CANCELED", async () => {
    subs.set("s1", { id: "s1", planId: "p1", providerSubId: null, status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: null });
    await cancelSubscription(makeReq({ atPeriodEnd: false }, { id: "s1" }), makeRes(), vi.fn() as never);
    expect(subs.get("s1")?.status).toBe("CANCELED");
    expect(subs.get("s1")?.canceledAt).toBeInstanceOf(Date);
  });
});
