/**
 * Reputation system tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      update: vi.fn().mockResolvedValue({ reputation: 5 }),
    },
  },
}));

describe("addReputation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("increments reputation for post_created (+2)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");

    await addReputation("user-1", "post_created");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { reputation: { increment: 2 } },
    });
  });

  it("increments reputation for review_posted (+5)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");

    await addReputation("user-1", "review_posted");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { reputation: { increment: 5 } },
    });
  });

  it("increments reputation for streak_7_days (+10)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");

    await addReputation("user-2", "streak_7_days");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { reputation: { increment: 10 } },
    });
  });

  it("increments reputation for streak_30_days (+25)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");

    await addReputation("user-2", "streak_30_days");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { reputation: { increment: 25 } },
    });
  });
});

describe("users.service — calculateXp", () => {
  it("returns level 1 for 0 reputation", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    const result = calculateXp(0);
    expect(result.level).toBe(1);
    expect(result.xp).toBe(0);
  });

  it("returns higher level for higher reputation", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    const low  = calculateXp(10);
    const high = calculateXp(1000);
    expect(high.level).toBeGreaterThanOrEqual(low.level);
  });

  it("title is a non-empty string", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    const result = calculateXp(500);
    expect(typeof result.title).toBe("string");
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("nextLevelXp is greater than current xp for low reputation", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    const result = calculateXp(10);
    expect(result.nextLevelXp).toBeGreaterThan(result.xp);
  });
});
