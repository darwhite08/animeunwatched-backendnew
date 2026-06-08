import { prisma } from "../../config/prisma";
import { notFound, forbidden, conflict } from "../../lib/errors";
import { auditMod } from "../../lib/audit";
import type { CreateClubDto, UpdateClubDto } from "./clubs.schema";

// ─── Shared select ────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(page = 1, limit = 20, q?: string, category?: string) {
  const { skip, take } = paginate(page, limit);
  const and: object[] = [];
  if (q) and.push({ OR: [
    { name:        { contains: q, mode: "insensitive" as const } },
    { slug:        { contains: q, mode: "insensitive" as const } },
    { description: { contains: q, mode: "insensitive" as const } },
  ] });
  if (category) and.push({ category });
  const where = and.length ? { AND: and } : undefined;

  const [data, total] = await prisma.$transaction([
    prisma.club.findMany({
      where,
      skip,
      take,
      orderBy: { reputation: "desc" },
      include: {
        _count: { select: { members: true, threads: true } },
      },
    }),
    prisma.club.count({ where }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string, userId?: string) {
  const club = await prisma.club.findUnique({
    where: { slug },
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
      chatGroup: { select: { id: true } },
    },
  });

  if (!club) throw notFound("Club not found");

  let isMember = false;
  let myRole: "USER" | "MOD" | "ADMIN" | null = null;
  if (userId) {
    const m = await prisma.clubMember.findUnique({ where: { userId_clubId: { userId, clubId: club.id } }, select: { role: true } });
    if (m) { isMember = true; myRole = m.role; }
  }
  const { chatGroup, ...rest } = club;
  return { club: { ...rest, isMember, myRole, hasChat: !!chatGroup } };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(ownerId: string, dto: CreateClubDto) {
  const user = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!user) throw notFound("User not found");

  if (user.reputation < 50) {
    throw forbidden("You need at least 50 reputation to create a club");
  }

  const club = await prisma.club.create({
    data: {
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      category: dto.category,
      ownerId,
    },
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
    },
  });

  // Auto-join as ADMIN
  await prisma.clubMember.create({
    data: {
      userId: ownerId,
      clubId: club.id,
      role: "ADMIN",
    },
  });

  return { club };
}

// ─── join ─────────────────────────────────────────────────────────────────────

export async function join(userId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Club not found");

  const existing = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId, clubId: club.id } },
  });
  if (existing) throw conflict("Already a member of this club");

  const membership = await prisma.clubMember.create({
    data: {
      userId,
      clubId: club.id,
      role: "USER",
    },
  });

  return { membership };
}

// ─── leave ────────────────────────────────────────────────────────────────────

export async function leave(userId: string, slug: string) {
  const club = await prisma.club.findUnique({ where: { slug }, include: { chatGroup: { select: { id: true } } } });
  if (!club) throw notFound("Club not found");

  if (club.ownerId === userId) {
    throw forbidden("Club owner cannot leave; transfer ownership first");
  }

  await prisma.clubMember.deleteMany({
    where: { userId, clubId: club.id },
  });
  // Drop them from the club chat room too (soft-leave so history stays attributed).
  if (club.chatGroup) {
    await prisma.groupMember.updateMany({
      where: { groupId: club.chatGroup.id, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
  }
}

// ─── club chat (realtime group room backed by ClubMember) ──────────────────────

function clubRoleToGroupRole(clubRole: string, isOwner: boolean): "OWNER" | "ADMIN" | "MEMBER" {
  if (isOwner) return "OWNER";
  if (clubRole === "ADMIN" || clubRole === "MOD") return "ADMIN";
  return "MEMBER";
}

/**
 * Resolve (and lazily create) the club's chat room. The room is a GroupConversation
 * with clubId set; its membership mirrors ClubMember — the caller is auto-added as a
 * GroupMember on first open (handles all existing club members without bulk sync).
 * Returns the groupId the client opens via the normal group thread.
 */
export async function getOrCreateClubChat(userId: string, slug: string) {
  const club = await prisma.club.findUnique({
    where: { slug },
    include: { chatGroup: { select: { id: true } } },
  });
  if (!club) throw notFound("Club not found");

  const membership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId, clubId: club.id } },
  });
  if (!membership) throw forbidden("Join the club to access its chat");

  // Create the backing group on first access.
  let groupId = club.chatGroup?.id;
  if (!groupId) {
    const created = await prisma.groupConversation.create({
      data: {
        title: club.name, ownerId: club.ownerId, clubId: club.id, isE2EE: false,
        members: { create: { userId, role: clubRoleToGroupRole(membership.role, club.ownerId === userId), addedBy: userId } },
      },
      select: { id: true },
    });
    groupId = created.id;
    // Seed a system message.
    await prisma.groupMessage.create({ data: { groupId, senderId: null, type: "SYSTEM", body: "Club chat created" } });
    return { groupId };
  }

  // Ensure the caller is an active member of the room (lazy join / rejoin).
  const gm = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { leftAt: true } });
  if (!gm) {
    await prisma.groupMember.create({ data: { groupId, userId, role: clubRoleToGroupRole(membership.role, club.ownerId === userId), addedBy: userId } });
  } else if (gm.leftAt) {
    await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { leftAt: null } });
  }
  return { groupId };
}

// ─── setMemberRole ────────────────────────────────────────────────────────────

export async function setMemberRole(
  actorId: string,
  slug: string,
  targetUserId: string,
  role: "USER" | "MOD" | "ADMIN",
) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Club not found");

  const actorMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: actorId, clubId: club.id } },
  });

  if (!actorMembership || actorMembership.role !== "ADMIN") {
    throw forbidden("Only club admins can change member roles");
  }

  const targetMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: targetUserId, clubId: club.id } },
  });
  if (!targetMembership) throw notFound("Target user is not a member of this club");

  const updated = await prisma.clubMember.update({
    where: { userId_clubId: { userId: targetUserId, clubId: club.id } },
    data: { role },
  });

  auditMod("club_role_changed", {
    actorId:      actorId,
    targetUserId: targetUserId,
    targetType:   "Club",
    targetId:     club.id,
    action:       `set_role:${role}`,
    extra:        { previousRole: targetMembership.role },
  });

  return { membership: updated };
}

// ─── getClubMembers ───────────────────────────────────────────────────────────

export async function getClubMembers(slug: string, page: number, limit: number) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Club not found");

  const [members, total] = await prisma.$transaction([
    prisma.clubMember.findMany({
      where: { clubId: club.id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            reputation: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.clubMember.count({ where: { clubId: club.id } }),
  ]);

  return { data: members, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(slug: string, actorId: string, dto: UpdateClubDto) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Club not found");

  const actorMembership = await prisma.clubMember.findUnique({
    where: { userId_clubId: { userId: actorId, clubId: club.id } },
  });

  if (!actorMembership || actorMembership.role !== "ADMIN") {
    throw forbidden("Only club admins can update club details");
  }

  const updated = await prisma.club.update({
    where: { slug },
    data: dto,
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
    },
  });

  return { club: updated };
}
