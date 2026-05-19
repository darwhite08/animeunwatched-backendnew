/**
 * More advanced clubs service tests — update, members listing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    club: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    clubMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const authorSelect = { id: "u1", username: "user1", displayName: "User", avatarUrl: null };

describe("clubs.service — setMemberRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { setMemberRole } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(setMemberRole("actor", "non-existent", "target", "MOD"))
      .rejects.toThrow("Club not found");
  });

  it("throws FORBIDDEN if actor is not admin", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { setMemberRole } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "c1", slug: "club" });
    // Actor is not ADMIN
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "actor", role: "USER" });

    await expect(setMemberRole("actor", "club", "target", "MOD"))
      .rejects.toThrow("Only club admins can change member roles");
  });

  it("updates member role when actor is admin", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { setMemberRole } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "c1", slug: "club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ userId: "actor", role: "ADMIN" })  // actor check
      .mockResolvedValueOnce({ userId: "target", role: "USER" });  // target check
    (prisma.clubMember.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "target", role: "MOD" });

    const result = await setMemberRole("actor", "club", "target", "MOD");
    expect(result.membership.role).toBe("MOD");
    expect(prisma.clubMember.update).toHaveBeenCalledWith({
      where: { userId_clubId: { userId: "target", clubId: "c1" } },
      data: { role: "MOD" },
    });
  });
});

describe("clubs.service — update (club info)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(update("non-existent", "user-1", {})).rejects.toThrow("Club not found");
  });

  it("throws FORBIDDEN if user is not an admin member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "c1", slug: "club" });
    // User is a USER role, not ADMIN
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "user-1", role: "USER" });

    await expect(update("club", "user-1", { name: "New Name" })).rejects.toThrow("Only club admins");
  });

  it("updates club successfully for admin member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "c1", slug: "club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "user-1", role: "ADMIN" });
    (prisma.club.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "c1", name: "New Name", slug: "club",
      owner: authorSelect, _count: { members: 5, threads: 2 },
    });

    const result = await update("club", "user-1", { name: "New Name" });
    expect(result.club.name).toBe("New Name");
  });
});

describe("clubs.service — getClubMembers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getClubMembers } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getClubMembers("non-existent")).rejects.toThrow("Club not found");
  });

  it("returns paginated members list", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getClubMembers } = await import("../app/src/modules/clubs/clubs.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "c1", slug: "club" });

    const mockMembers = [
      { userId: "u1", role: "ADMIN", joinedAt: new Date(), user: authorSelect },
      { userId: "u2", role: "USER",  joinedAt: new Date(), user: { ...authorSelect, id: "u2", username: "user2" } },
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockMembers, 2]);

    const result = await getClubMembers("club", 1, 20);
    expect(result.data).toHaveLength(2);
    expect(result.meta.total).toBe(2);
  });
});
