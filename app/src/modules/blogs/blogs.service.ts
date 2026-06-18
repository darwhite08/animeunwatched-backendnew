import crypto from "node:crypto";
import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { auditDelete } from "../../lib/audit";
import { broadcastBlogViews, broadcastBlogLikes } from "../../realtime/broadcast";
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
      verifiedKind: true, communityLead: true,
    },
  },
} as const;

// ─── Ranking: "Kaiveron Blog Rank" ────────────────────────────────────────────
// trending = quality-weighted engagement × gentle time decay (blogs are read
//   over days, so gravity is softer than Hacker News).
// top      = same quality signal with NO decay → best-of-all-time.
// latest   = pure reverse-chronological.
//
// QualityFactor uses a Wilson lower-bound on like-per-view so low-sample posts
// aren't over/under-rated and raw reach can't dominate. Views are already
// deduped (one per unique viewer/day), so they're hard to game.

export type BlogSort = "trending" | "top" | "latest";

/** 95% Wilson lower bound for `positives` successes out of `trials`. 0 when n=0. */
function wilsonLowerBound(positives: number, trials: number): number {
  if (trials <= 0) return 0;
  const z = 1.96;
  const p = positives / trials;
  return (
    (p + (z * z) / (2 * trials) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials)) /
    (1 + (z * z) / trials)
  );
}

type ScoredBlog = {
  likeCount: number;
  viewCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  author: { verifiedKind: unknown; reputation: number } | null;
  _count: { comments: number };
};

function blogRankScore(b: ScoredBlog, nowMs: number, decay: boolean): number {
  const likes = b.likeCount ?? 0;
  const views = b.viewCount ?? 0;
  const comments = b._count?.comments ?? 0;
  const rep = b.author?.reputation ?? 0;
  const verified = b.author?.verifiedKind ? 1 : 0;

  // Comments (depth) > likes > views (log-damped so reach can't run away).
  const baseEngagement = 3 * likes + 5 * comments + Math.log(1 + views);
  // 0.5–1.0: rewards like-per-view with statistical confidence.
  const qualityFactor = 0.5 + 0.5 * wilsonLowerBound(likes, views);
  // Light, capped credibility nudge for verified / high-rep authors.
  const authorFactor = 1 + 0.15 * verified + Math.min(0.25, rep / 20_000);
  const quality = baseEngagement * qualityFactor * authorFactor;

  if (!decay) return quality; // "top"

  const publishedMs = (b.publishedAt ?? b.createdAt).getTime();
  const ageHours = Math.max(0, (nowMs - publishedMs) / 3_600_000);
  const G = 1.5; // gravity — gentler than HN's 1.8 so blogs live for days
  let score = quality / Math.pow(ageHours + 2, G);
  // Cold-start grace: keep brand-new posts visible during their first day even
  // before they've earned engagement.
  if (ageHours < 24) score += 0.5 / Math.pow(ageHours + 2, 0.5);
  return score;
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(page = 1, limit = 20, category?: BlogCategory, sort: BlogSort = "trending") {
  const where = { status: "PUBLISHED" as const, ...(category ? { category } : {}) };

  // Latest: pure reverse-chron, paginated in the DB (cheap + exact).
  if (sort === "latest") {
    const { skip, take } = paginate(page, limit);
    const [data, total] = await prisma.$transaction([
      prisma.blog.findMany({ where, skip, take, orderBy: { publishedAt: "desc" }, include: blogInclude }),
      prisma.blog.count({ where }),
    ]);
    return { data, meta: meta(total, page, limit) };
  }

  // Trending / Top: score in-app over a recent candidate window. O(cap) at blog
  // volume; a materialized rankScore column + recompute job is the scale path.
  const CAP = 500;
  const candidates = await prisma.blog.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: CAP,
    include: {
      author: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, verifiedKind: true, communityLead: true, reputation: true },
      },
      _count: { select: { comments: true } },
    },
  });

  const nowMs = Date.now();
  const decay = sort === "trending";
  const ranked = candidates
    .map((b) => ({ b, score: blogRankScore(b, nowMs, decay) }))
    .sort((a, z) => z.score - a.score);

  const start = (page - 1) * limit;
  const data = ranked.slice(start, start + limit).map((x) => x.b);
  return { data, meta: meta(ranked.length, page, limit) };
}

// ─── getBySlug ────────────────────────────────────────────────────────────────

export async function getBySlug(slug: string, userId?: string) {
  const blog = await prisma.blog.findUnique({ where: { slug }, include: blogInclude });

  if (!blog) throw notFound("Blog not found");
  // Drafts AND scheduled (not-yet-published) blogs are visible only to the author.
  if (blog.status !== "PUBLISHED" && blog.authorId !== userId) {
    throw notFound("Blog not found");
  }

  // Whether the current viewer has already liked this — lets the like button
  // render in the correct state on load (persists across refresh).
  const likedByMe = userId
    ? (await prisma.blogLike.findUnique({
        where: { userId_blogId: { userId, blogId: blog.id } },
        select: { userId: true },
      })) != null
    : false;

  return { blog: { ...blog, likedByMe } };
}

// ─── like / unlike ──────────────────────────────────────────────────────────
// Idempotent: liking twice (or unliking when not liked) is a no-op that returns
// the current state. Keeps Blog.likeCount in lockstep with the BlogLike rows and
// broadcasts the live count to everyone reading the blog.

export async function like(slug: string, userId: string): Promise<{ likeCount: number; likedByMe: boolean }> {
  const blog = await prisma.blog.findUnique({ where: { slug }, select: { id: true, status: true, likeCount: true } });
  if (!blog || blog.status !== "PUBLISHED") throw notFound("Blog not found");

  try {
    await prisma.blogLike.create({ data: { userId, blogId: blog.id } });
  } catch {
    // Already liked → idempotent no-op.
    return { likeCount: blog.likeCount, likedByMe: true };
  }
  const updated = await prisma.blog.update({
    where: { id: blog.id },
    data: { likeCount: { increment: 1 } },
    select: { likeCount: true },
  });
  broadcastBlogLikes(slug, updated.likeCount);
  return { likeCount: updated.likeCount, likedByMe: true };
}

export async function unlike(slug: string, userId: string): Promise<{ likeCount: number; likedByMe: boolean }> {
  const blog = await prisma.blog.findUnique({ where: { slug }, select: { id: true, likeCount: true } });
  if (!blog) throw notFound("Blog not found");

  const { count } = await prisma.blogLike.deleteMany({ where: { userId, blogId: blog.id } });
  if (count === 0) {
    // Wasn't liked → idempotent no-op.
    return { likeCount: blog.likeCount, likedByMe: false };
  }
  const updated = await prisma.blog.update({
    where: { id: blog.id },
    // Guard against ever going negative if counters ever drift.
    data: { likeCount: { decrement: 1 } },
    select: { likeCount: true },
  });
  const safeCount = Math.max(0, updated.likeCount);
  broadcastBlogLikes(slug, safeCount);
  return { likeCount: safeCount, likedByMe: false };
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
      include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verifiedKind: true, communityLead: true } } },
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
    include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verifiedKind: true, communityLead: true } } },
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
