import { prisma } from "../../config/prisma";
import { notFound, forbidden, conflict } from "../../lib/errors";
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

export async function list(page = 1, limit = 20) {
  const { skip, take } = paginate(page, limit);

  const [data, total] = await prisma.$transaction([
    prisma.club.findMany({
      skip,
      take,
      orderBy: { reputation: "desc" },
      include: {
        _count: { select: { members: true } },
      },
    }),
    prisma.club.count(),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string) {
  const club = await prisma.club.findUnique({
    where: { slug },
    include: {
      owner: { select: authorSelect },
      _count: { select: { members: true, threads: true } },
    },
  });

  if (!club) throw notFound("Club not found");

  return { club };
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
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) throw notFound("Club not found");

  if (club.ownerId === userId) {
    throw forbidden("Club owner cannot leave; transfer ownership first");
  }

  await prisma.clubMember.deleteMany({
    where: { userId, clubId: club.id },
  });
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
