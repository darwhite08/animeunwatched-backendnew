import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * These tests model the Postgres `SELECT ... FOR UPDATE` row lock as a real
 * async mutex acquired by the counter SELECT and released at transaction commit.
 * That's the meaningful guarantee: GIVEN the DB serializes the locked counter
 * section, the grant arithmetic never over-issues. If the grant code read the
 * counter WITHOUT the lock, the mutex wouldn't be held and concurrent calls
 * would interleave → over-grant → these tests would fail.
 */

const h = vi.hoisted(() => {
  const store = {
    counter: { id: 1, issued: 0, cap: 250 },
    badges: [] as Array<{ id: string; userId: string; code: string; serial: number | null; earnedAt: Date }>,
    seq: 0,
    locked: false,
    waiters: [] as Array<() => void>,
  };
  const acquire = (): Promise<void> => {
    if (!store.locked) { store.locked = true; return Promise.resolve(); }
    return new Promise<void>((res) => store.waiters.push(res));
  };
  const release = (): void => {
    const next = store.waiters.shift();
    if (next) next();          // hand the lock to the next waiter (stays locked)
    else store.locked = false; // nobody waiting → free it
  };
  const findBadge = (userId: string, code: string) =>
    store.badges.find((b) => b.userId === userId && b.code === code) ?? null;
  return { store, acquire, release, findBadge };
});

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    foundingCounter: {
      upsert: async () => h.store.counter,
      findUnique: async () => h.store.counter,
    },
    userBadge: {
      findUnique: async ({ where }: { where: { userId_code: { userId: string; code: string } } }) =>
        h.findBadge(where.userId_code.userId, where.userId_code.code),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let held = false;
      const tx = {
        // FOR UPDATE select → acquire the counter row lock, return current value.
        $queryRaw: async () => { await h.acquire(); held = true; return [{ issued: h.store.counter.issued, cap: h.store.counter.cap }]; },
        // UPDATE issued = <serial>
        $executeRaw: async (_s: TemplateStringsArray, ...vals: number[]) => { h.store.counter.issued = vals[0]; return 1; },
        userBadge: {
          findUnique: async ({ where }: { where: { userId_code: { userId: string; code: string } } }) =>
            h.findBadge(where.userId_code.userId, where.userId_code.code),
          create: async ({ data }: { data: { userId: string; code: string; serial?: number | null } }) => {
            if (h.findBadge(data.userId, data.code)) throw new Error("mock unique violation (userId, code)");
            if (data.serial != null && h.store.badges.some((b) => b.code === data.code && b.serial === data.serial)) {
              throw new Error("mock unique violation (code, serial)");
            }
            const row = { id: `b${++h.store.seq}`, userId: data.userId, code: data.code, serial: data.serial ?? null, earnedAt: new Date(0) };
            h.store.badges.push(row);
            return row;
          },
        },
      };
      try { return await fn(tx); }
      finally { if (held) h.release(); }
    },
  },
}));

beforeEach(() => {
  h.store.counter = { id: 1, issued: 0, cap: 250 };
  h.store.badges = [];
  h.store.seq = 0;
  h.store.locked = false;
  h.store.waiters = [];
});

describe("grantFoundingCreatorBadge", () => {
  it("issues exactly cap badges under heavy concurrency (300 users → 250 badges, serials 1..250)", async () => {
    const { grantFoundingCreatorBadge } = await import("../app/src/lib/founding");
    const userIds = Array.from({ length: 300 }, (_, i) => `user-${i}`);

    const results = await Promise.all(userIds.map((id) => grantFoundingCreatorBadge(id)));

    const granted = results.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(granted).toHaveLength(250);

    const serials = granted.map((b) => b.serial).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(serials).toEqual(Array.from({ length: 250 }, (_, i) => i + 1)); // 1..250, no gaps/dupes
    expect(new Set(serials).size).toBe(250);                                // no duplicates

    expect(h.store.counter.issued).toBe(250);
    expect(h.store.badges).toHaveLength(250);
  });

  it("is idempotent: two grants for the same user → one badge, counter incremented once", async () => {
    const { grantFoundingCreatorBadge } = await import("../app/src/lib/founding");

    const first = await grantFoundingCreatorBadge("solo");
    const second = await grantFoundingCreatorBadge("solo");

    expect(first?.serial).toBe(1);
    expect(second?.serial).toBe(1);          // same badge returned, not a new serial
    expect(second?.id).toBe(first?.id);
    expect(h.store.counter.issued).toBe(1);  // incremented exactly once
    expect(h.store.badges.filter((b) => b.userId === "solo")).toHaveLength(1);
  });

  it("returns null once the window is closed (issued = cap), leaving the counter unchanged", async () => {
    const { grantFoundingCreatorBadge } = await import("../app/src/lib/founding");
    h.store.counter.issued = 250; // window already full

    const result = await grantFoundingCreatorBadge("late-creator");

    expect(result).toBeNull();
    expect(h.store.counter.issued).toBe(250);                 // unchanged
    expect(h.findBadge("late-creator", "FOUNDING_CREATOR")).toBeNull();
  });
});
