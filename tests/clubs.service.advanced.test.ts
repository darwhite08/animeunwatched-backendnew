/**
 * Advanced clubs service tests — leave, setMemberRole, getMembers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    club: { findUnique: vi.fn() },
    clubMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("clubs.service — leave", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { leave } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(leave("user-1", "non-existent")).rejects.toThrow("Club not found");
  });

  it("silently succeeds when user is not a member (deleteMany with 0 deletions)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { leave } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "club-1", slug: "my-club", ownerId: "other-owner",
    });

    await expect(leave("non-member-user", "my-club")).resolves.not.toThrow();
    expect(prisma.clubMember.deleteMany).toHaveBeenCalled();
  });

  it("prevents owner from leaving (FORBIDDEN)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { leave } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "club-1", slug: "my-club", ownerId: "user-1", // user IS the owner
    });

    await expect(leave("user-1", "my-club")).rejects.toThrow("Club owner cannot leave");
  });

  it("allows non-owner members to leave", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { leave } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "club-1", slug: "my-club", ownerId: "owner-user",
    });

    await expect(leave("user-1", "my-club")).resolves.not.toThrow();
    // leave uses deleteMany
    expect(prisma.clubMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", clubId: "club-1" },
    });
  });
});

describe("clubs.service — getBySlug", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getBySlug } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getBySlug("non-existent")).rejects.toThrow("Club not found");
  });

  it("returns club data for valid slug", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getBySlug } = await import("../app/src/modules/clubs/clubs.service");

    const mockClub = {
      id: "club-1",
      name: "Anime Lovers",
      slug: "anime-lovers",
      ownerId: "user-1",
      owner: { id: "user-1", username: "owner", displayName: "Owner", avatarUrl: null },
      _count: { members: 15, threads: 20 },
    };
    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockClub);

    const result = await getBySlug("anime-lovers");
    expect(result.club.name).toBe("Anime Lovers");
    expect(result.club._count.members).toBe(15);
  });
});
