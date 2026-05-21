import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import type { CreateBlogDto, UpdateBlogDto } from "./blogs.schema";

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

export async function list(page = 1, limit = 20) {
  const { skip, take } = paginate(page, limit);

  const [data, total] = await prisma.$transaction([
    prisma.blog.findMany({
      where: { status: "PUBLISHED" },
      skip,
      take,
      orderBy: { publishedAt: "desc" },
      include: blogInclude,
    }),
    prisma.blog.count({ where: { status: "PUBLISHED" } }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string, userId?: string) {
  const blog = await prisma.blog.findUnique({ where: { slug }, include: blogInclude });

  if (!blog) throw notFound("Blog not found");
  if (blog.status === "DRAFT" && blog.authorId !== userId) {
    throw notFound("Blog not found");
  }

  return { blog };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(authorId: string, dto: CreateBlogDto) {
  const slug = toSlug(dto.title);
  const isPublished = dto.status === "PUBLISHED";

  const blog = await prisma.blog.create({
    data: {
      authorId,
      title: dto.title,
      body: dto.body,
      slug,
      status: dto.status ?? "DRAFT",
      ...(isPublished ? { publishedAt: new Date() } : {}),
    },
    include: blogInclude,
  });
  if (isPublished) addReputation(authorId, "blog_published").catch(console.error);

  return { blog };
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(slug: string, userId: string, dto: UpdateBlogDto) {
  const blog = await prisma.blog.findUnique({ where: { slug } });
  if (!blog) throw notFound("Blog not found");
  if (blog.authorId !== userId) throw forbidden("Not allowed to edit this blog");

  const newSlug = dto.title ? toSlug(dto.title) : undefined;
  const isPublishing = dto.status === "PUBLISHED" && blog.status !== "PUBLISHED";

  const updated = await prisma.blog.update({
    where: { slug },
    data: {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(newSlug ? { slug: newSlug } : {}),
      ...(isPublishing ? { publishedAt: new Date() } : {}),
    },
    include: blogInclude,
  });

  return { blog: updated };
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
}
