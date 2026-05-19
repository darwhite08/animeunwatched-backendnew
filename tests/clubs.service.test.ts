/**
 * Clubs service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    club: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    clubMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("clubs.service — create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND if user doesn't exist", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(create("user-1", { name: "Club", slug: "club" })).rejects.toThrow("User not found");
  });

  it("throws FORBIDDEN if user has < 50 reputation", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "user-1", reputation: 10,
    });

    await expect(create("user-1", { name: "My Club", slug: "my-club" }))
      .rejects.toThrow("at least 50 reputation");
  });

  it("creates a club and auto-joins as ADMIN for user with sufficient reputation", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "user-1", reputation: 100,
    });

    const mockClub = { id: "club-1", name: "My Club", slug: "my-club",
      owner: { id: "user-1", username: "user1", displayName: "User", avatarUrl: null },
      _count: { members: 1, threads: 0 } };
    (prisma.club.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockClub);
    (prisma.clubMember.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await create("user-1", { name: "My Club", slug: "my-club" });

    expect(result.club.name).toBe("My Club");
    expect(prisma.clubMember.create).toHaveBeenCalledWith({
      data: { userId: "user-1", clubId: "club-1", role: "ADMIN" },
    });
  });
});

describe("clubs.service — join", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { join } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(join("user-1", "non-existent-club")).rejects.toThrow("Club not found");
  });

  it("throws CONFLICT if already a member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { join } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "club-1", slug: "my-club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "user-1" });

    await expect(join("user-1", "my-club")).rejects.toThrow("Already a member");
  });

  it("creates membership for new member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { join } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "club-1", slug: "my-club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (prisma.clubMember.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userId: "user-1", clubId: "club-1", role: "USER",
    });

    const result = await join("user-1", "my-club");
    expect(result.membership.role).toBe("USER");
  });
});

describe("clubs.service — list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated clubs sorted by reputation", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/clubs/clubs.service");

    const mockClubs = [
      { id: "c1", name: "Club A", reputation: 100, _count: { members: 5, threads: 3 } },
      { id: "c2", name: "Club B", reputation: 50,  _count: { members: 2, threads: 1 } },
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockClubs, 2]);

    const result = await list(1, 20);
    expect(result.data).toHaveLength(2);
    expect(result.meta.total).toBe(2);
  });
});
