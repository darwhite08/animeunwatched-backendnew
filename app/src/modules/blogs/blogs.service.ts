import crypto from "node:crypto";
import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { auditDelete } from "../../lib/audit";
import { broadcastBlogViews } from "../../realtime/broadcast";
import { env } from "../../config/env";
import type { BlogCategory, CreateBlogDto, UpdateBlogDto } from "./blogs.schema";

// ─── Pagination helpers ───────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── Slug generation ──────────────────────────────────────────────────────────

function toSlug(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // append a short cuid-like suffix to ensure uniqueness
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

// ─── Shared include ───────────────────────────────────────────────────────────

const blogInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} as const;

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(page = 1, limit = 20, category?: BlogCategory) {
  const { skip, take } = paginate(page, limit);
  const where = { status: "PUBLISHED" as const, ...(category ? { category } : {}) };

  const [data, total] = await prisma.$transaction([
    prisma.blog.findMany({
      where,
      skip,
      take,
      orderBy: { publishedAt: "desc" },
      include: blogInclude,
    }),
    prisma.blog.count({ where }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string, userId?: string) {
  const blog = await prisma.blog.findUnique({ where: { slug }, include: blogInclude });

  if (!blog) throw notFound("Blog not found");
  // Drafts AND scheduled (not-yet-published) blogs are visible only to the author.
  if (blog.status !== "PUBLISHED" && blog.authorId !== userId) {
    throw notFound("Blog not found");
  }

  return { blog };
}

// ─── recordView ───────────────────────────────────────────────────────────────
// Deduplicated, realtime view counting. One count per unique viewer per UTC day
// (refreshes / repeat visits within a day don't inflate; a later day re-counts).
// The author's own views are never counted. On a genuinely new view we bump the
// denormalized counter and broadcast the live total to everyone reading the blog.

export async function recordView(
  slug: string,
  viewer: { userId?: string; ip?: string; userAgent?: string },
): Promise<{ viewCount: number }> {
  const blog = await prisma.blog.findUnique({
    where: { slug },
    select: { id: true, status: true, authorId: true, viewCount: true },
  });
  // Only published blogs accrue views; silently ignore anything else.
  if (!blog || blog.status !== "PUBLISHED") return { viewCount: blog?.viewCount ?? 0 };

  // Don't count the author viewing their own post.
  if (viewer.userId && viewer.userId === blog.authorId) return { viewCount: blog.viewCount };

  const viewerKey = viewer.userId
    ? `u:${viewer.userId}`
    : `a:${crypto.createHash("sha256")
        .update(`${viewer.ip ?? "?"}|${viewer.userAgent ?? "?"}|${env.JWT_ACCESS_SECRET}`)
        .digest("hex").slice(0, 32)}`;
  const day = new Date().toISOString().slice(0, 10);

  try {
    await prisma.blogView.create({ data: { blogId: blog.id, viewerKey, day } });
  } catch {
    // Unique violation → already counted this viewer today. No-op.
    return { viewCount: blog.viewCount };
  }

  const updated = await prisma.blog.update({
    where: { id: blog.id },
    data: { viewCount: { increment: 1 } },
    select: { viewCount: true },
  });
  broadcastBlogViews(slug, updated.viewCount);
  return { viewCount: updated.viewCount };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(authorId: string, dto: CreateBlogDto) {
  const slug = toSlug(dto.title);
  const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
  // A future scheduledAt forces SCHEDULED; only publish now if explicitly PUBLISHED.
  const isScheduled = dto.status === "SCHEDULED" && scheduledAt && scheduledAt.getTime() > Date.now();
  const isPublished = dto.status === "PUBLISHED" && !isScheduled;

  const blog = await prisma.blog.create({
    data: {
      authorId,
      title: dto.title,
      body: dto.body,
      slug,
      status: isScheduled ? "SCHEDULED" : isPublished ? "PUBLISHED" : "DRAFT",
      category: dto.category ?? null,
      hasSpoilers: dto.hasSpoilers ?? false,
      // animeTitle only makes sense alongside an anime id — drop it otherwise.
      animeMalId: dto.animeMalId ?? null,
      animeTitle: dto.animeMalId ? (dto.animeTitle ?? null) : null,
      ...(isScheduled ? { scheduledAt } : {}),
      ...(isPublished ? { publishedAt: new Date() } : {}),
    },
    include: blogInclude,
  });
  if (isPublished) addReputation(authorId, "blog_published").catch(console.error);

  // First-blog badge — on first PUBLISHED blog only (drafts don't count)
  if (isPublished) {
    void (async () => {
      const n = await prisma.blog.count({ where: { authorId, status: "PUBLISHED" } });
      if (n === 1) await (await import("../../lib/badges")).awardBadge(authorId, "FIRST_BLOG");
    })().catch(() => {});
  }

  return { blog };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(slug: string, userId: string, dto: UpdateBlogDto) {
  const blog = await prisma.blog.findUnique({ where: { slug } });
  if (!blog) throw notFound("Blog not found");
  if (blog.authorId !== userId) throw forbidden("Not allowed to edit this blog");

  const newSlug = dto.title ? toSlug(dto.title) : undefined;
  const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
  const isScheduling = dto.status === "SCHEDULED" && scheduledAt && scheduledAt.getTime() > Date.now();
  const isPublishing = dto.status === "PUBLISHED" && blog.status !== "PUBLISHED" && !isScheduling;

  const updated = await prisma.blog.update({
    where: { slug },
    data: {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.hasSpoilers !== undefined ? { hasSpoilers: dto.hasSpoilers } : {}),
      ...(dto.animeMalId !== undefined
        ? { animeMalId: dto.animeMalId, animeTitle: dto.animeMalId ? (dto.animeTitle ?? null) : null }
        : {}),
      ...(dto.status !== undefined ? { status: isScheduling ? "SCHEDULED" : dto.status } : {}),
      ...(newSlug ? { slug: newSlug } : {}),
      ...(isScheduling ? { scheduledAt } : {}),
      ...(dto.scheduledAt === null ? { scheduledAt: null } : {}),
      ...(isPublishing ? { publishedAt: new Date(), scheduledAt: null } : {}),
    },
    include: blogInclude,
  });

  return { blog: updated };
}

// ─── publish due scheduled blogs (background job, every minute) ───────────────

/** Publishes any SCHEDULED blogs whose scheduledAt has passed. */
export async function publishDueScheduled(): Promise<number> {
  const due = await prisma.blog.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    select: { id: true, authorId: true },
  });
  if (due.length === 0) return 0;
  await prisma.blog.updateMany({
    where: { id: { in: due.map((b) => b.id) } },
    data: { status: "PUBLISHED", publishedAt: new Date(), scheduledAt: null },
  });
  for (const b of due) addReputation(b.authorId, "blog_published").catch(console.error);
  return due.length;
}

// ─── getComments ─────────────────────────────────────────────────────────────

export async function getComments(slug: string, page = 1, limit = 20) {
  const blog = await prisma.blog.findUnique({ where: { slug }, select: { id: true } })
  if (!blog) throw notFound("Blog not found")
  const skip = (page - 1) * limit
  const [data, total] = await prisma.$transaction([
    prisma.blogComment.findMany({
      where: { blogId: blog.id },
      include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      skip, take: limit,
    }),
    prisma.blogComment.count({ where: { blogId: blog.id } }),
  ])
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } }
}

// ─── createComment ────────────────────────────────────────────────────────────

export async function createComment(slug: string, authorId: string, content: string) {
  const blog = await prisma.blog.findUnique({ where: { slug }, select: { id: true } })
  if (!blog) throw notFound("Blog not found")
  const comment = await prisma.blogComment.create({
    data: { blogId: blog.id, authorId, content },
    include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  })
  return { comment }
}

// ─── deleteBlog ───────────────────────────────────────────────────────────────

export async function deleteBlog(slug: string, userId: string, role: string) {
  const blog = await prisma.blog.findUnique({ where: { slug } });
  if (!blog) throw notFound("Blog not found");

  const canDelete = blog.authorId === userId || role === "MOD" || role === "ADMIN";
  if (!canDelete) throw forbidden("Not allowed to delete this blog");

  await prisma.blog.delete({ where: { slug } });

  auditDelete("blog_deleted", {
    actorId:    userId,
    targetType: "Blog",
    targetId:   blog.id,
    extra: blog.authorId !== userId ? { byMod: true, originalAuthorId: blog.authorId } : undefined,
  });
}
