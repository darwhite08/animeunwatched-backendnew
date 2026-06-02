import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const store: Array<{ tokenHash: string; userId: string; purpose: string; consumedAt: Date | null; expiresAt: Date }> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    stepUpToken: {
      create: vi.fn(async ({ data }: { data: { tokenHash: string; userId: string; purpose: string; expiresAt: Date } }) => {
        store.push({ ...data, consumedAt: null });
        return data;
      }),
      findUnique: vi.fn(async ({ where: { tokenHash } }: { where: { tokenHash: string } }) =>
        store.find(t => t.tokenHash === tokenHash) ?? null),
      update: vi.fn(async ({ where: { tokenHash }, data }: { where: { tokenHash: string }; data: { consumedAt: Date } }) => {
        const t = store.find(x => x.tokenHash === tokenHash);
        if (t) t.consumedAt = data.consumedAt;
        return t;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { issueStepUpToken, consumeStepUpToken } from "../app/src/lib/stepup";

beforeEach(() => { store.length = 0; });

describe("stepup", () => {
  it("issues a base64url token and stores its SHA-256 hash (not the raw token)", async () => {
    const raw = await issueStepUpToken("u1", "users:role");
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store).toHaveLength(1);
    expect(store[0].tokenHash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
  });

  it("consumes once and rejects replay", async () => {
    const raw = await issueStepUpToken("u1", "users:role");
    expect(await consumeStepUpToken("u1", raw, "users:role")).toBe(true);
    expect(await consumeStepUpToken("u1", raw, "users:role")).toBe(false);
  });

  it("rejects when user mismatch", async () => {
    const raw = await issueStepUpToken("u1", "users:role");
    expect(await consumeStepUpToken("uX", raw, "users:role")).toBe(false);
  });

  it("rejects when purpose mismatch", async () => {
    const raw = await issueStepUpToken("u1", "users:role");
    expect(await consumeStepUpToken("u1", raw, "users:delete")).toBe(false);
  });

  it("rejects expired tokens", async () => {
    const raw = await issueStepUpToken("u1", "users:role");
    store[0].expiresAt = new Date(Date.now() - 1000);
    expect(await consumeStepUpToken("u1", raw, "users:role")).toBe(false);
  });
});
