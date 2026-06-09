import { prisma } from "../../config/prisma";
import { evaluateEligibility } from "../../lib/monetizationMath";
import { notFound } from "../../lib/errors";

// ─── A creator's own content (incl. drafts) for the Creator Studio ───────────

/** All of a creator's blogs — drafts AND published — newest first. */
export async function getMyBlogs(userId: string) {
  const blogs = await prisma.blog.findMany({
    where: { authorId: userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, slug: true, title: true, status: true,
      publishedAt: true, scheduledAt: true, createdAt: true, updatedAt: true,
      _count: { select: { comments: true } },
    },
  });
  return {
    items: blogs.map((b) => ({
      id: b.id, slug: b.slug, title: b.title, status: b.status,
      publishedAt: b.publishedAt?.toISOString() ?? null,
      scheduledAt: b.scheduledAt?.toISOString() ?? null,
      updatedAt: b.updatedAt.toISOString(), comments: b._count.comments,
    })),
  };
}

/** A creator's own feed posts (newest first) with engagement counts. The feed
 *  itself is open to all users; this is the creator's management view. */
export async function getMyPosts(userId: string) {
  const posts = await prisma.post.findMany({
    where: { authorId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, content: true, imageUrl: true, imageUrls: true, createdAt: true,
      anime: { select: { title: true, malId: true } },
      _count: { select: { likes: true, comments: true } },
    },
  });
  return {
    items: posts.map((p) => ({
      id: p.id, content: p.content, imageUrl: p.imageUrl,
      imageUrls: p.imageUrls.length ? p.imageUrls : p.imageUrl ? [p.imageUrl] : [],
      createdAt: p.createdAt.toISOString(),
      anime: p.anime ? { title: p.anime.title, malId: p.anime.malId } : null,
      likes: p._count.likes, comments: p._count.comments,
    })),
  };
}

/** Creator level + verified status — a gamified tier ladder from a transparent
 *  "creator score" (reputation + followers + published content). Self-contained. */
const CREATOR_TIERS = [
  { min: 0,     title: "Newcomer" },
  { min: 100,   title: "Rising" },
  { min: 500,   title: "Creator" },
  { min: 1_500, title: "Established" },
  { min: 4_000, title: "Elite" },
  { min: 10_000, title: "Luminary" },
  { min: 25_000, title: "Icon" },
] as const;

export async function getCreatorLevel(userId: string) {
  const [user, followers, blogs, polls, shots, posts] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { reputation: true, verifiedKind: true, verifiedAt: true } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } }),
    prisma.blog.count({ where: { authorId: userId, status: "PUBLISHED" } }),
    prisma.poll.count({ where: { authorId: userId } }),
    prisma.shot.count({ where: { authorId: userId, deletedAt: null } }),
    prisma.post.count({ where: { authorId: userId, deletedAt: null } }),
  ]);
  const reputation = user?.reputation ?? 0;
  const content = blogs + polls + shots + posts;
  // Transparent score: reputation + 3·followers + 25·published content.
  const score = reputation + followers * 3 + content * 25;

  let idx = 0;
  for (let i = 0; i < CREATOR_TIERS.length; i++) if (score >= CREATOR_TIERS[i].min) idx = i;
  const tier = CREATOR_TIERS[idx];
  const next = CREATOR_TIERS[idx + 1] ?? null;
  const span = next ? next.min - tier.min : 1;
  const into = score - tier.min;
  const progressPct = next ? Math.min(100, (into / span) * 100) : 100;

  return {
    level: idx + 1,
    title: tier.title,
    nextTitle: next?.title ?? null,
    score,
    nextAt: next?.min ?? null,
    toNext: next ? Math.max(0, next.min - score) : 0,
    progressPct,
    verifiedKind: user?.verifiedKind ?? null,
    verifiedAt: user?.verifiedAt?.toISOString() ?? null,
    breakdown: { reputation, followers, content },
  };
}

/** Public creator storefront — a branded hub: profile + level + tiers + recent
 *  content across formats. Powers the consumer /c/[handle] page. */
export async function getStorefront(username: string, viewerId?: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, slug: true, displayName: true, avatarUrl: true, bio: true, verifiedKind: true, reputation: true, createdAt: true },
  });
  if (!user) throw notFound("Creator not found");
  const uid = user.id;

  const [followers, level, profile, tiers, blogs, shots, posts, reviews, clubs, isFollowing] = await Promise.all([
    prisma.follow.count({ where: { followingId: uid, status: "ACCEPTED" } }),
    getCreatorLevel(uid),
    prisma.creatorProfile.findUnique({ where: { userId: uid }, select: { status: true, isEligible: true } }),
    prisma.creatorTier.findMany({ where: { creatorId: uid, active: true }, orderBy: { priceCents: "asc" }, select: { id: true, name: true, description: true, priceCents: true, currency: true, perks: true } }),
    prisma.blog.findMany({ where: { authorId: uid, status: "PUBLISHED" }, orderBy: { publishedAt: "desc" }, take: 4, select: { slug: true, title: true, publishedAt: true } }),
    prisma.shot.findMany({ where: { authorId: uid, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, thumbnailUrl: true, caption: true } }),
    prisma.post.findMany({ where: { authorId: uid, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 4, select: { id: true, content: true, imageUrl: true, createdAt: true } }),
    prisma.review.findMany({ where: { authorId: uid }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, score: true, body: true, anime: { select: { malId: true, title: true, imageUrl: true } } } }),
    prisma.club.findMany({ where: { ownerId: uid }, orderBy: { createdAt: "desc" }, take: 4, select: { slug: true, name: true, _count: { select: { members: true } } } }),
    viewerId ? prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: uid } }, select: { status: true } }) : Promise.resolve(null),
  ]);

  return {
    creator: { id: uid, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, bio: user.bio, verifiedKind: user.verifiedKind, joinedAt: user.createdAt.toISOString() },
    stats: { followers, reputation: user.reputation, level: level.level, tierTitle: level.title },
    isMonetized: !!profile && (profile.status === "active" || profile.status === "eligible" || profile.isEligible),
    isFollowing: isFollowing?.status === "ACCEPTED",
    tiers,
    content: {
      blogs: blogs.map((b) => ({ slug: b.slug, title: b.title, publishedAt: b.publishedAt?.toISOString() ?? null })),
      shots: shots.map((s) => ({ id: s.id, thumbnailUrl: s.thumbnailUrl, caption: s.caption })),
      posts: posts.map((p) => ({ id: p.id, content: p.content.slice(0, 200), imageUrl: p.imageUrl, createdAt: p.createdAt.toISOString() })),
      reviews: reviews.map((r) => ({ id: r.id, score: r.score, snippet: r.body.slice(0, 160), anime: r.anime })),
      clubs: clubs.map((c) => ({ slug: c.slug, name: c.name, members: c._count.members })),
    },
  };
}

/** A creator's own anime reviews — newest first, with anime + engagement. */
export async function getMyReviews(userId: string) {
  const reviews = await prisma.review.findMany({
    where: { authorId: userId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true, score: true, body: true, createdAt: true,
      anime: { select: { malId: true, title: true, imageUrl: true } },
      _count: { select: { likes: true } },
    },
  });
  return {
    items: reviews.map((r) => ({
      id: r.id, score: r.score,
      snippet: r.body.slice(0, 200),
      createdAt: r.createdAt.toISOString(),
      likes: r._count.likes,
      anime: r.anime ? { malId: r.anime.malId, title: r.anime.title, imageUrl: r.anime.imageUrl } : null,
    })),
  };
}

/** Clubs the creator owns, with member counts — community management overview. */
export async function getMyClubs(userId: string) {
  const clubs = await prisma.club.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, slug: true, name: true, description: true, category: true, createdAt: true,
      _count: { select: { members: true } },
    },
  });
  return {
    items: clubs.map((c) => ({
      id: c.id, slug: c.slug, name: c.name, description: c.description, category: c.category,
      members: c._count.members, createdAt: c.createdAt.toISOString(),
    })),
  };
}

/** Community inbox: recent comments/replies from others on the creator's content
 *  (posts, blogs, activities) — a YouTube-Studio-style engagement queue. */
export async function getEngagementInbox(userId: string) {
  const sel = { username: true, displayName: true, avatarUrl: true };
  const [postC, blogC, replies, follows] = await Promise.all([
    prisma.postComment.findMany({
      where: { post: { authorId: userId }, authorId: { not: userId } },
      orderBy: { createdAt: "desc" }, take: 25,
      select: { id: true, content: true, createdAt: true, author: { select: sel }, post: { select: { id: true, content: true } } },
    }),
    prisma.blogComment.findMany({
      where: { blog: { authorId: userId }, authorId: { not: userId } },
      orderBy: { createdAt: "desc" }, take: 25,
      select: { id: true, content: true, createdAt: true, author: { select: sel }, blog: { select: { title: true, slug: true } } },
    }),
    prisma.reply.findMany({
      where: { activity: { authorId: userId }, authorId: { not: userId } },
      orderBy: { createdAt: "desc" }, take: 25,
      select: { id: true, body: true, createdAt: true, author: { select: sel }, activity: { select: { id: true, body: true } } },
    }),
    prisma.follow.findMany({
      where: { followingId: userId, status: "ACCEPTED" }, orderBy: { createdAt: "desc" }, take: 25,
      select: { followerId: true, createdAt: true, follower: { select: sel } },
    }),
  ]);

  type ReplyTo = { kind: "post" | "blog" | "activity"; id: string } | null;
  const items = [
    ...postC.map((c) => ({ id: c.id, type: "comment" as const, surface: "post", text: c.content, createdAt: c.createdAt.toISOString(), author: c.author, target: { label: "your post", snippet: c.post?.content?.slice(0, 90) ?? null, href: null as string | null }, replyTo: (c.post ? { kind: "post", id: c.post.id } : null) as ReplyTo })),
    ...blogC.map((c) => ({ id: c.id, type: "comment" as const, surface: "blog", text: c.content, createdAt: c.createdAt.toISOString(), author: c.author, target: { label: c.blog?.title ?? "your blog", snippet: null, href: c.blog ? `/blog/${c.blog.slug}` : null }, replyTo: (c.blog ? { kind: "blog", id: c.blog.slug } : null) as ReplyTo })),
    ...replies.map((r) => ({ id: r.id, type: "comment" as const, surface: "activity", text: r.body, createdAt: r.createdAt.toISOString(), author: r.author, target: { label: "your activity", snippet: r.activity?.body?.slice(0, 90) ?? null, href: null }, replyTo: (r.activity ? { kind: "activity", id: r.activity.id } : null) as ReplyTo })),
    ...follows.map((f) => ({ id: `follow-${f.followerId}`, type: "follow" as const, surface: "follow", text: "started following you", createdAt: f.createdAt.toISOString(), author: f.follower, target: { label: "", snippet: null, href: null }, replyTo: null as ReplyTo })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40);

  return { items, commentCount: postC.length + blogC.length + replies.length };
}

/** All of a creator's polls with option vote tallies. */
export async function getMyPolls(userId: string) {
  const polls = await prisma.poll.findMany({
    where: { authorId: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, question: true, expiresAt: true, createdAt: true,
      options: { select: { id: true, label: true, _count: { select: { votes: true } } }, orderBy: { order: "asc" } },
      _count: { select: { votes: true } },
    },
  });
  return {
    items: polls.map((p) => ({
      id: p.id, question: p.question,
      expiresAt: p.expiresAt.toISOString(), createdAt: p.createdAt.toISOString(),
      totalVotes: p._count.votes,
      expired: p.expiresAt.getTime() < Date.now(),
      options: p.options.map((o) => ({ id: o.id, label: o.label, votes: o._count.votes })),
    })),
  };
}

/**
 * Whether a user may access the Creator Studio. Not everyone is a creator — the
 * studio is gated. Access is granted when ANY holds:
 *   - admin-granted creator status (CreatorProfile.status = "active")
 *   - they meet the auto-qualify criteria (followers / reputation / age / standing)
 *   - they're already an active creator (have published a blog)
 * Denied users get the exact criteria they still need to meet.
 */
export async function getCreatorAccess(userId: string) {
  const [user, followers, publishedBlogs, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, reputation: true, isBanned: true, isShadowBanned: true } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } }),
    prisma.blog.count({ where: { authorId: userId, status: "PUBLISHED" } }),
    prisma.creatorProfile.findUnique({ where: { userId }, select: { status: true } }),
  ]);
  if (!user) return { hasAccess: false, reasons: ["User not found"], followers: 0, reputation: 0, publishedBlogs: 0 };

  const accountAgeDays = (Date.now() - user.createdAt.getTime()) / 86_400_000;
  const elig = evaluateEligibility({
    followers, reputation: user.reputation, accountAgeDays,
    inGoodStanding: !user.isBanned && !user.isShadowBanned,
  });

  const granted = profile?.status === "active";
  const isExistingCreator = publishedBlogs > 0;
  const hasAccess = granted || elig.isEligible || isExistingCreator;

  return {
    hasAccess,
    granted,
    reasons: hasAccess ? [] : elig.reasons,
    followers,
    reputation: user.reputation,
    publishedBlogs,
  };
}


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
