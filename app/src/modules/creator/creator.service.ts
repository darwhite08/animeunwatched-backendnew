import { prisma } from "../../config/prisma";

// ─── getDailySeries ───────────────────────────────────────────────────────────

/**
 * Last 7 days of posts + likes + comments created by this user, grouped
 * by day in UTC. Used by the creator analytics chart so the bars are
 * real data instead of mock numbers.
 */
export async function getDailySeries(userId: string) {
  const day = 24 * 60 * 60 * 1000
  const since = new Date(Date.now() - 7 * day)

  const rows = await prisma.$queryRaw<Array<{ day: Date; posts: bigint; likes: bigint; comments: bigint }>>`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${since}::timestamptz),
        date_trunc('day', NOW()),
        '1 day'::interval
      )::date AS day
    )
    SELECT
      d.day,
      COALESCE((SELECT COUNT(*) FROM "Post"        WHERE "authorId" = ${userId} AND date_trunc('day', "createdAt") = d.day AND "deletedAt" IS NULL), 0) AS posts,
      COALESCE((SELECT COUNT(*) FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId" WHERE p."authorId" = ${userId} AND date_trunc('day', pl."createdAt"::timestamptz) = d.day), 0) AS likes,
      COALESCE((SELECT COUNT(*) FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId" WHERE p."authorId" = ${userId} AND date_trunc('day', pc."createdAt") = d.day), 0) AS comments
    FROM days d
    ORDER BY d.day
  `

  return rows.map(r => ({
    day:      r.day.toISOString().slice(0, 10),
    posts:    Number(r.posts),
    likes:    Number(r.likes),
    comments: Number(r.comments),
  }))
}

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

  // Views placeholder: a deterministic estimate based on blog ID hash
  // TODO: wire to a real analytics table once view tracking is implemented
  const data = blogs.map((blog: BlogRow) => ({
    ...blog,
    views: 0,
  }));

  return { data, count: data.length };
}
