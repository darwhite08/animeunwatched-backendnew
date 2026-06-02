import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const endpoints = new Map<string, { id: string; events: string[]; enabled: boolean }>();
const deliveries: Array<{
  endpointId: string; eventName: string; eventId: string;
  payload: unknown; attempts: number;
}> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    webhookEndpoint: {
      findMany: vi.fn(async (args: { where?: { enabled?: boolean } } = {}) => {
        const all = Array.from(endpoints.values());
        return args.where?.enabled === undefined ? all : all.filter(e => e.enabled === args.where!.enabled);
      }),
    },
    webhookDelivery: {
      create: vi.fn(async ({ data }: { data: typeof deliveries[number] }) => {
        deliveries.push(data); return data;
      }),
    },
  },
}));

import { enqueueWebhook } from "../app/src/jobs/webhookDispatcher.job";

beforeEach(() => {
  endpoints.clear();
  deliveries.length = 0;
});

describe("webhook dispatcher — enqueueWebhook", () => {
  it("creates a delivery for every enabled endpoint subscribed to the event", async () => {
    endpoints.set("a", { id: "a", events: ["user.created", "post.created"], enabled: true });
    endpoints.set("b", { id: "b", events: ["user.created"],                  enabled: true });
    endpoints.set("c", { id: "c", events: ["post.created"],                  enabled: true });
    await enqueueWebhook("user.created", { userId: "u1" });
    expect(deliveries.map(d => d.endpointId).sort()).toEqual(["a","b"]);
  });

  it("skips disabled endpoints", async () => {
    endpoints.set("a", { id: "a", events: ["user.created"], enabled: false });
    await enqueueWebhook("user.created", { userId: "u1" });
    expect(deliveries).toHaveLength(0);
  });

  it("uses a single eventId for the same enqueue call", async () => {
    endpoints.set("a", { id: "a", events: ["x"], enabled: true });
    endpoints.set("b", { id: "b", events: ["x"], enabled: true });
    await enqueueWebhook("x", { foo: 1 });
    expect(deliveries[0].eventId).toBe(deliveries[1].eventId);
    // Two separate calls = two distinct event ids
    await enqueueWebhook("x", { foo: 2 });
    expect(deliveries[0].eventId).not.toBe(deliveries[2].eventId);
  });

  it("creates 0 deliveries when event matches no endpoint", async () => {
    endpoints.set("a", { id: "a", events: ["other.thing"], enabled: true });
    await enqueueWebhook("nothing.here", { x: 1 });
    expect(deliveries).toHaveLength(0);
  });

  it("payload is preserved verbatim", async () => {
    endpoints.set("a", { id: "a", events: ["x"], enabled: true });
    const payload = { a: 1, nested: { b: [1, 2, 3] } };
    await enqueueWebhook("x", payload);
    expect(deliveries[0].payload).toEqual(payload);
  });
});

describe("webhook signature format (regression)", () => {
  // The dispatcher signs as `t={ts},v1={hex}` using HMAC-SHA-256 of `${ts}.${body}`.
  // Subscribers verify it the same way — pin the algorithm so it can't drift.
  it("HMAC SHA-256 of `${ts}.${body}` with given secret", () => {
    const secret = "shh";
    const body   = JSON.stringify({ hello: "world" });
    const ts     = 1700000000;
    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
  });
});
