import { prisma } from "../../config/prisma";

// ─── getCreatorStats ──────────────────────────────────────────────────────────

export async function getCreatorStats(userId: string) {
  const [blogsPublished, postsCreated, user] = await prisma.$transaction([
    prisma.blog.count({ where: { authorId: userId, status: "PUBLISHED" } }),
    prisma.post.count({ where: { authorId: userId, deletedAt: null } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { reputation: true },
    }),
  ]);

  // Mock: total blog views = blogsPublished * 1200
  const totalBlogViews = blogsPublished * 1200;

  return {
    blogsPublished,
    totalBlogViews,
    postsCreated,
    reputation: user?.reputation ?? 0,
  };
}

// ─── getContentPerformance ────────────────────────────────────────────────────

export async function getContentPerformance(userId: string) {
  const blogs = await prisma.blog.findMany({
    where: { authorId: userId, status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  type BlogRow = (typeof blogs)[number];

  // Add mock views (random 800-15000 per blog)
  const data = blogs.map((blog: BlogRow) => ({
    ...blog,
    views: Math.floor(Math.random() * (15000 - 800 + 1)) + 800,
  }));

  return { data, count: data.length };
}
