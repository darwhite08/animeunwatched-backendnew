/**
 * Advanced users service tests — getProfile, getFollowers, getFollowing, getXp.
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
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/lib/notify", () => ({
  createNotification: vi.fn().mockResolvedValue({}),
  NotificationType: { NEW_FOLLOWER: "new_follower" },
}));

describe("users.service — getProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent username", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getProfile } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getProfile("ghostuser")).rejects.toThrow("User not found");
  });

  it("returns profile with stats", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getProfile } = await import("../app/src/modules/users/users.service");

    const mockUser = {
      id: "u1", email: "user@example.com", username: "user1", displayName: "User One",
      bio: null, avatarUrl: null, role: "USER", reputation: 500, createdAt: new Date(),
      _count: { followers: 100, following: 50, listEntries: 200, reviews: 25 },
      posts: [{ id: "p1", content: "Post", animeId: null, createdAt: new Date() }],
      reviews: [{ id: "r1", animeId: "a1", score: 8, body: "Review", createdAt: new Date() }],
    };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUser);

    const result = await getProfile("user1");
    expect(result.user.username).toBe("user1");
    expect(result.stats.followers).toBe(100);
    expect(result.stats.listCount).toBe(200);
  });
});

describe("users.service — getXp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getXp } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getXp("ghostuser")).rejects.toThrow("User not found");
  });

  it("returns XP data for existing user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getXp } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "u1", username: "user1", reputation: 500,
    });

    const result = await getXp("user1");
    expect(result.xp).toBe(500 * 100);
    expect(result.level).toBeGreaterThan(0);
    expect(typeof result.title).toBe("string");
  });
});

describe("users.service — getFollowers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getFollowers } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getFollowers("ghostuser")).rejects.toThrow("User not found");
  });

  it("returns paginated followers", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getFollowers } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    const mockRows = [
      { follower: { id: "u2", username: "user2", displayName: "User 2", reputation: 50, createdAt: new Date(), avatarUrl: null, email: "u2@x.com", role: "USER", isBanned: false } }
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, 1]);

    const result = await getFollowers("user1", 1, 20);
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });
});

describe("users.service — unfollow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent target user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { unfollow } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(unfollow("u1", "ghostuser")).rejects.toThrow("User not found");
  });

  it("removes follow relationship", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { unfollow } = await import("../app/src/modules/users/users.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u2", username: "user2" });
    (prisma.follow.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });

    await expect(unfollow("u1", "user2")).resolves.not.toThrow();
    expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
      where: { followerId: "u1", followingId: "u2" },
    });
  });
});
