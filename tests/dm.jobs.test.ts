/** DM background jobs (spec §8): nightly purge + hourly unread reconcile. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    directMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn() },
    conversation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));
const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

describe("runDmNightlyCleanup", () => {
  it("purges tombstoned messages and stale DECLINED conversations", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { runDmNightlyCleanup } = await import("../app/src/jobs/dmMaintenance.job");
    await runDmNightlyCleanup();
    expect(fn(prisma.directMessage.deleteMany)).toHaveBeenCalledOnce();
    expect(fn(prisma.conversation.deleteMany).mock.calls[0][0].where.status).toBe("DECLINED");
  });
});

describe("runDmUnreadReconcile", () => {
  it("rewrites counters only when actual differs from stored", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { runDmUnreadReconcile } = await import("../app/src/jobs/dmMaintenance.job");
    fn(prisma.conversation.findMany).mockResolvedValue([
      { id: "c1", participant1: "a", participant2: "b", p1UnreadCount: 5, p2UnreadCount: 0 }, // drift
      { id: "c2", participant1: "a", participant2: "b", p1UnreadCount: 0, p2UnreadCount: 0 }, // ok
    ]);
    // c1: actual p1=2,p2=0 (drift) ; c2: actual 0,0 (no update)
    fn(prisma.directMessage.count)
      .mockResolvedValueOnce(2).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    await runDmUnreadReconcile();
    expect(fn(prisma.conversation.update)).toHaveBeenCalledTimes(1);
    expect(fn(prisma.conversation.update).mock.calls[0][0].data.p1UnreadCount).toBe(2);
  });
});
