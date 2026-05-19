/**
 * Users service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    follow: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
    },
    userOAuthProvider: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../app/src/lib/notify", () => ({
  createNotification: vi.fn().mockResolvedValue({}),
  NotificationType: { NEW_FOLLOWER: "new_follower" },
}));

describe("calculateXp", () => {
  it("returns level 1 for 0 rep", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    expect(calculateXp(0).level).toBe(1);
    expect(calculateXp(0).title).toBe("Neophyte");
  });

  it("xp = reputation * 100", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    expect(calculateXp(5).xp).toBe(500);
  });

  it("level increases with reputation", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    expect(calculateXp(5).level).toBeGreaterThanOrEqual(1);
    expect(calculateXp(50).level).toBeGreaterThan(calculateXp(5).level);
  });

  it("title is defined for any rep", async () => {
    const { calculateXp } = await import("../app/src/modules/users/users.service");
    for (const rep of [0, 5, 15, 30, 60, 120, 250, 500, 1000, 2000, 5000]) {
      const result = calculateXp(rep);
      expect(typeof result.title).toBe("string");
      expect(result.title.length).toBeGreaterThan(0);
    }
  });
});

describe("follow service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent target user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { follow } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(follow("caller-id", "ghostuser")).rejects.toThrow("User not found");
  });

  it("throws CONFLICT when trying to follow yourself", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { follow } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "same-id", username: "me" });

    await expect(follow("same-id", "me")).rejects.toThrow("cannot follow yourself");
  });
});

describe("updateMe service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates user profile fields", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { updateMe } = await import("../app/src/modules/users/users.service");

    const updatedUser = {
      id: "u1", email: "a@b.com", username: "user1", displayName: "New Name",
      bio: "New bio", avatarUrl: null, role: "USER", reputation: 0, createdAt: new Date(),
    };
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedUser);

    const result = await updateMe("u1", { displayName: "New Name", bio: "New bio" });
    expect(result.user.displayName).toBe("New Name");
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { displayName: "New Name", bio: "New bio" },
      select: expect.any(Object),
    });
  });
});
