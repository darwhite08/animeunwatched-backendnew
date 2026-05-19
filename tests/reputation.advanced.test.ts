/**
 * Advanced reputation system tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      update: vi.fn().mockResolvedValue({ reputation: 100 }),
    },
  },
}));

describe("addReputation — all event types", () => {
  beforeEach(() => vi.clearAllMocks());

  const eventValues: Array<[string, number]> = [
    ["post_created",    2],
    ["review_posted",   5],
    ["review_liked",    1],
    ["streak_7_days",   10],
    ["streak_30_days",  25],
    ["blog_published",  8],
    ["first_follower",  5],
    ["post_liked",      1],
    ["list_100_anime",  15],
  ];

  for (const [event, expectedDelta] of eventValues) {
    it(`awards ${expectedDelta} reputation for ${event}`, async () => {
      const { prisma } = await import("../app/src/config/prisma");
      const { addReputation } = await import("../app/src/lib/reputation");

      await addReputation("user-1", event as Parameters<typeof addReputation>[1]);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { reputation: { increment: expectedDelta } },
      });
    });
  }
});

describe("users.service — calculateXp — level titles", () => {
  const levelTitleMap = [
    [0, "Neophyte"],
    [5, "Initiate"],
    [15, "Apprentice"],
    [30, "Shinobi"],
    [60, "Jonin"],
    [120, "Anbu"],
    [250, "Elite Jonin"],
    [500, "Kage"],
    [1000, "Legendary"],
    [2000, "Arch-Mage"],
  ];

  for (const [rep, expectedTitle] of levelTitleMap) {
    it(`user with ${rep} reputation has title "${expectedTitle}"`, async () => {
      const { calculateXp } = await import("../app/src/modules/users/users.service");
      const result = calculateXp(rep as number);
      expect(result.title).toBe(expectedTitle as string);
    });
  }
});
