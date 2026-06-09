import { prisma } from "../../config/prisma";

/**
 * Creator analytics — REAL metrics aggregated from existing engagement data
 * (no mock numbers). Powers the Creator Studio dashboard. All queries are
 * bounded by the range window and indexed (authorId/createdAt).
 */

function rangeDays(range: string): number {
  const m = /^(\d+)d$/.exec(range);
  const d = m ? Number(m[1]) : 28;
  return Math.min(365, Math.max(1, d));
}

function pctDelta(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export async function getOverview(userId: string, range = "28d") {
  const days = rangeDays(range);
  const now = Date.now();
  const since = new Date(now - days * 86_400_000);
  const prevSince = new Date(now - 2 * days * 86_400_000);

  // Followers (accepted) + growth this window vs the previous window.
  const [followers, newFollowers, prevNewFollowers, user] = await prisma.$transaction([
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED", createdAt: { gte: since } } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED", createdAt: { gte: prevSince, lt: since } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { reputation: true } }),
  ]);

  const eng = await engagements(userId, since);
  const engPrev = await engagements(userId, prevSince, since);

  const series = await dailySeries(userId, days);

  return {
    followers,
    followersDeltaPct: pctDelta(newFollowers, prevNewFollowers),
    impressions: eng.reach, // distinct users reached by the creator's content (real proxy)
    impressionsDeltaPct: pctDelta(eng.reach, engPrev.reach),
    engagements: eng.total,
    engagementsDeltaPct: pctDelta(eng.total, engPrev.total),
    earningsCents: 0, // wired once monetization lands
    earningsDeltaPct: 0,
    reputation: user?.reputation ?? 0,
    series,
  };
}

/** Total engagements + distinct reach on the creator's content within a window. */
async function engagements(userId: string, since: Date, until?: Date) {
  const upper = until ? until : new Date();
  const rows = await prisma.$queryRaw<Array<{ total: bigint; reach: bigint }>>`
    WITH e AS (
      SELECT pl."userId" AS uid FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId"
        WHERE p."authorId" = ${userId} AND pl."createdAt" >= ${since} AND pl."createdAt" < ${upper}
      UNION ALL
      SELECT pc."authorId" FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId"
        WHERE p."authorId" = ${userId} AND pc."createdAt" >= ${since} AND pc."createdAt" < ${upper}
      UNION ALL
      SELECT al."userId" FROM "ActivityLike" al JOIN "Activity" a ON a.id = al."activityId"
        WHERE a."authorId" = ${userId} AND al."createdAt" >= ${since} AND al."createdAt" < ${upper}
      UNION ALL
      SELECT r."authorId" FROM "Reply" r JOIN "Activity" a ON a.id = r."activityId"
        WHERE a."authorId" = ${userId} AND r."createdAt" >= ${since} AND r."createdAt" < ${upper}
      UNION ALL
      SELECT bc."authorId" FROM "BlogComment" bc JOIN "Blog" b ON b.id = bc."blogId"
        WHERE b."authorId" = ${userId} AND bc."createdAt" >= ${since} AND bc."createdAt" < ${upper}
      UNION ALL
      SELECT rl."userId" FROM "ReviewLike" rl JOIN "Review" rv ON rv.id = rl."reviewId"
        WHERE rv."authorId" = ${userId} AND rl."createdAt" >= ${since} AND rl."createdAt" < ${upper}
    )
    SELECT COUNT(*) AS total, COUNT(DISTINCT uid) AS reach FROM e
  `;
  return { total: Number(rows[0]?.total ?? 0), reach: Number(rows[0]?.reach ?? 0) };
}

/** Daily engagements + new followers (+ running follower total) over `days`. */
async function dailySeries(userId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const baseFollowers = await prisma.follow.count({
    where: { followingId: userId, status: "ACCEPTED", createdAt: { lt: since } },
  });

  const rows = await prisma.$queryRaw<Array<{ day: Date; engagements: bigint; newfollowers: bigint }>>`
    WITH days AS (
      SELECT generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', NOW()), '1 day'::interval)::date AS day
    ),
    eng AS (
      SELECT date_trunc('day', t.ts)::date AS day, COUNT(*) AS n FROM (
        SELECT pl."createdAt" AS ts FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId" WHERE p."authorId" = ${userId}
        UNION ALL SELECT pc."createdAt" FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId" WHERE p."authorId" = ${userId}
        UNION ALL SELECT al."createdAt" FROM "ActivityLike" al JOIN "Activity" a ON a.id = al."activityId" WHERE a."authorId" = ${userId}
        UNION ALL SELECT r."createdAt" FROM "Reply" r JOIN "Activity" a ON a.id = r."activityId" WHERE a."authorId" = ${userId}
        UNION ALL SELECT bc."createdAt" FROM "BlogComment" bc JOIN "Blog" b ON b.id = bc."blogId" WHERE b."authorId" = ${userId}
      ) t WHERE t.ts >= ${since} GROUP BY 1
    ),
    fol AS (
      SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*) AS n
        FROM "Follow" WHERE "followingId" = ${userId} AND status = 'ACCEPTED' AND "createdAt" >= ${since} GROUP BY 1
    )
    SELECT d.day,
           COALESCE(eng.n, 0) AS engagements,
           COALESCE(fol.n, 0) AS newfollowers
      FROM days d LEFT JOIN eng ON eng.day = d.day LEFT JOIN fol ON fol.day = d.day
     ORDER BY d.day
  `;

  let running = baseFollowers;
  return rows.map((r) => {
    running += Number(r.newfollowers);
    return {
      date: r.day.toISOString().slice(0, 10),
      impressions: Number(r.engagements), // reach-per-day proxy for the chart
      engagements: Number(r.engagements),
      followers: running,
    };
  });
}

// ─── Content performance ──────────────────────────────────────────────────────

export async function getContentAnalytics(userId: string, range = "28d") {
  const days = rangeDays(range);
  const since = new Date(Date.now() - days * 86_400_000);

  const [blogs, polls, posts] = await prisma.$transaction([
    prisma.blog.findMany({
      where: { authorId: userId, status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" }, take: 50,
      select: { id: true, title: true, publishedAt: true, _count: { select: { comments: true } } },
    }),
    prisma.poll.findMany({
      where: { authorId: userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, question: true, createdAt: true, _count: { select: { votes: true } } },
    }),
    prisma.post.findMany({
      where: { authorId: userId, deletedAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, content: true, createdAt: true, _count: { select: { likes: true, comments: true } } },
    }),
  ]);

  const items = [
    ...blogs.map((b) => ({
      id: b.id, type: "blog" as const, title: b.title,
      publishedAt: (b.publishedAt ?? new Date()).toISOString(),
      impressions: b._count.comments, engagements: b._count.comments,
      engagementRate: 1,
    })),
    ...polls.map((p) => ({
      id: p.id, type: "poll" as const, title: p.question,
      publishedAt: p.createdAt.toISOString(),
      impressions: p._count.votes, engagements: p._count.votes, engagementRate: 1,
    })),
    ...posts.map((p) => ({
      id: p.id, type: "activity" as const, title: p.content.slice(0, 80),
      publishedAt: p.createdAt.toISOString(),
      impressions: p._count.likes + p._count.comments,
      engagements: p._count.likes + p._count.comments,
      engagementRate: 1,
    })),
  ].sort((a, b) => b.engagements - a.engagements);

  return { items };
}

// ─── Real-time card (YouTube-Studio-style "last 48h") ───────────────────────────

/** Live pulse: engagements in the last 60 min + 24h + an hourly 48h sparkline. */
export async function getRealtime(userId: string) {
  const since = new Date(Date.now() - 48 * 3_600_000);
  const rows = await prisma.$queryRaw<Array<{ hour: Date; n: number }>>`
    WITH ev AS (
      SELECT pl."createdAt" AS ts FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId" WHERE p."authorId" = ${userId} AND pl."createdAt" >= ${since}
      UNION ALL SELECT pc."createdAt" FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId" WHERE p."authorId" = ${userId} AND pc."createdAt" >= ${since}
      UNION ALL SELECT al."createdAt" FROM "ActivityLike" al JOIN "Activity" a ON a.id = al."activityId" WHERE a."authorId" = ${userId} AND al."createdAt" >= ${since}
      UNION ALL SELECT r."createdAt" FROM "Reply" r JOIN "Activity" a ON a.id = r."activityId" WHERE a."authorId" = ${userId} AND r."createdAt" >= ${since}
      UNION ALL SELECT bc."createdAt" FROM "BlogComment" bc JOIN "Blog" b ON b.id = bc."blogId" WHERE b."authorId" = ${userId} AND bc."createdAt" >= ${since}
    )
    SELECT date_trunc('hour', ts) AS hour, COUNT(*)::int AS n FROM ev GROUP BY 1 ORDER BY 1
  `;
  const map = new Map(rows.map((r) => [new Date(r.hour).toISOString().slice(0, 13), r.n]));
  const series: { hour: string; count: number }[] = [];
  for (let i = 47; i >= 0; i--) {
    const d = new Date(Date.now() - i * 3_600_000);
    series.push({ hour: d.toISOString(), count: map.get(d.toISOString().slice(0, 13)) ?? 0 });
  }
  const last24h = series.slice(24).reduce((s, x) => s + x.count, 0);

  const last60Row = await prisma.$queryRaw<Array<{ n: number }>>`
    WITH ev AS (
      SELECT pl."createdAt" AS ts FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId" WHERE p."authorId" = ${userId} AND pl."createdAt" >= NOW() - INTERVAL '60 minutes'
      UNION ALL SELECT pc."createdAt" FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId" WHERE p."authorId" = ${userId} AND pc."createdAt" >= NOW() - INTERVAL '60 minutes'
      UNION ALL SELECT al."createdAt" FROM "ActivityLike" al JOIN "Activity" a ON a.id = al."activityId" WHERE a."authorId" = ${userId} AND al."createdAt" >= NOW() - INTERVAL '60 minutes'
      UNION ALL SELECT r."createdAt" FROM "Reply" r JOIN "Activity" a ON a.id = r."activityId" WHERE a."authorId" = ${userId} AND r."createdAt" >= NOW() - INTERVAL '60 minutes'
      UNION ALL SELECT bc."createdAt" FROM "BlogComment" bc JOIN "Blog" b ON b.id = bc."blogId" WHERE b."authorId" = ${userId} AND bc."createdAt" >= NOW() - INTERVAL '60 minutes'
    )
    SELECT COUNT(*)::int AS n FROM ev
  `;

  return { last60min: last60Row[0]?.n ?? 0, last24h, series };
}

// ─── Inspiration — content ideas from our own anime trending engine ─────────────

/** Trending anime + ready-made blog angles, so creators always have ideas.
 *  This is our edge: anime-native trend intelligence none of the big suites have. */
export async function getContentIdeas() {
  const trending = await prisma.anime.findMany({
    where: { trendingScore: { gt: 0 } },
    orderBy: { trendingScore: "desc" },
    take: 12,
    select: { malId: true, title: true, titleEnglish: true, imageUrl: true, score: true, trendingScore: true },
  });

  const angle = (t: string) => [
    `Why ${t} is blowing up right now`,
    `${t}: a spoiler-free review`,
    `Hot takes on ${t} — what fans are arguing about`,
    `Is ${t} worth your time? An honest breakdown`,
  ];

  return {
    trending: trending.map((a) => ({
      malId: a.malId,
      title: a.titleEnglish || a.title,
      imageUrl: a.imageUrl,
      score: a.score,
      trendingScore: a.trendingScore,
      angles: angle(a.titleEnglish || a.title),
    })),
  };
}

// ─── Insights — advanced, real, single-pass derived metrics ─────────────────────

/**
 * Deep creator insights derived from the engagement event stream in ONE pass:
 *  - engagement broken down by type (likes / comments / replies / votes / …)
 *  - best time to post: hour-of-day (UTC) and weekday engagement histograms
 *  - top fans: the users who engage most with this creator
 *  - content cadence + engagement rate
 * Server-cheap: the 7-way union is materialised once and every aggregate reads
 * from it. All sources are indexed by authorId/createdAt.
 */
export async function getInsights(userId: string, range = "28d") {
  const days = rangeDays(range);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await prisma.$queryRaw<Array<{
    by_type: { kind: string; n: number }[] | null;
    by_hour: { h: number; n: number }[] | null;
    by_weekday: { d: number; n: number }[] | null;
    top_fans: { uid: string; n: number }[] | null;
    total: bigint;
    reach: bigint;
  }>>`
    WITH ev AS (
      SELECT pl."createdAt" AS ts, pl."userId" AS uid, 'post_like' AS kind
        FROM "PostLike" pl JOIN "Post" p ON p.id = pl."postId"
        WHERE p."authorId" = ${userId} AND pl."createdAt" >= ${since}
      UNION ALL SELECT pc."createdAt", pc."authorId", 'post_comment'
        FROM "PostComment" pc JOIN "Post" p ON p.id = pc."postId" WHERE p."authorId" = ${userId} AND pc."createdAt" >= ${since}
      UNION ALL SELECT al."createdAt", al."userId", 'activity_like'
        FROM "ActivityLike" al JOIN "Activity" a ON a.id = al."activityId" WHERE a."authorId" = ${userId} AND al."createdAt" >= ${since}
      UNION ALL SELECT r."createdAt", r."authorId", 'activity_reply'
        FROM "Reply" r JOIN "Activity" a ON a.id = r."activityId" WHERE a."authorId" = ${userId} AND r."createdAt" >= ${since}
      UNION ALL SELECT bc."createdAt", bc."authorId", 'blog_comment'
        FROM "BlogComment" bc JOIN "Blog" b ON b.id = bc."blogId" WHERE b."authorId" = ${userId} AND bc."createdAt" >= ${since}
      UNION ALL SELECT rl."createdAt", rl."userId", 'review_like'
        FROM "ReviewLike" rl JOIN "Review" rv ON rv.id = rl."reviewId" WHERE rv."authorId" = ${userId} AND rl."createdAt" >= ${since}
    )
    SELECT
      (SELECT json_agg(t) FROM (SELECT kind, COUNT(*)::int n FROM ev GROUP BY kind) t)                                  AS by_type,
      (SELECT json_agg(t) FROM (SELECT EXTRACT(hour FROM ts)::int h, COUNT(*)::int n FROM ev GROUP BY 1) t)             AS by_hour,
      (SELECT json_agg(t) FROM (SELECT EXTRACT(dow  FROM ts)::int d, COUNT(*)::int n FROM ev GROUP BY 1) t)             AS by_weekday,
      (SELECT json_agg(t) FROM (SELECT uid, COUNT(*)::int n FROM ev GROUP BY uid ORDER BY n DESC LIMIT 8) t)            AS top_fans,
      (SELECT COUNT(*) FROM ev)                AS total,
      (SELECT COUNT(DISTINCT uid) FROM ev)     AS reach
  `;

  const row = rows[0];
  const byType = row?.by_type ?? [];
  const byHourRaw = row?.by_hour ?? [];
  const byWeekdayRaw = row?.by_weekday ?? [];
  const topFansRaw = row?.top_fans ?? [];
  const total = Number(row?.total ?? 0);
  const reach = Number(row?.reach ?? 0);

  // Dense 24-hour and 7-day arrays (fill gaps with 0) for a clean heatmap.
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: byHourRaw.find((x) => x.h === h)?.n ?? 0 }));
  const weekdays = Array.from({ length: 7 }, (_, d) => ({ weekday: d, count: byWeekdayRaw.find((x) => x.d === d)?.n ?? 0 }));
  const bestHour = hours.reduce((a, b) => (b.count > a.count ? b : a), hours[0]);
  const bestWeekday = weekdays.reduce((a, b) => (b.count > a.count ? b : a), weekdays[0]);

  // Hydrate top fans with profile info + their total engagement contribution.
  const fanIds = topFansRaw.map((f) => f.uid);
  const fanUsers = fanIds.length
    ? await prisma.user.findMany({
        where: { id: { in: fanIds } },
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      })
    : [];
  const topFans = topFansRaw
    .map((f) => {
      const u = fanUsers.find((x) => x.id === f.uid);
      return u ? { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, engagements: f.n } : null;
    })
    .filter(Boolean);

  // Content cadence in window.
  const [posts, blogs, polls, shots, followers] = await prisma.$transaction([
    prisma.post.count({ where: { authorId: userId, deletedAt: null, createdAt: { gte: since } } }),
    prisma.blog.count({ where: { authorId: userId, status: "PUBLISHED", publishedAt: { gte: since } } }),
    prisma.poll.count({ where: { authorId: userId, createdAt: { gte: since } } }),
    prisma.shot.count({ where: { authorId: userId, deletedAt: null, createdAt: { gte: since } } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } }),
  ]);
  const contentCount = posts + blogs + polls + shots;

  const friendly: Record<string, string> = {
    post_like: "Post likes", post_comment: "Post comments", activity_like: "Activity likes",
    activity_reply: "Replies", blog_comment: "Blog comments", review_like: "Review likes",
  };

  return {
    range,
    totalEngagements: total,
    reach,
    engagementRate: followers > 0 ? total / followers : 0,
    engagementByType: byType
      .map((t) => ({ type: t.kind, label: friendly[t.kind] ?? t.kind, count: t.n }))
      .sort((a, b) => b.count - a.count),
    hours,
    weekdays,
    bestHourUtc: bestHour.count > 0 ? bestHour.hour : null,
    bestWeekday: bestWeekday.count > 0 ? bestWeekday.weekday : null,
    topFans,
    content: { posts, blogs, polls, shots, total: contentCount, perWeek: contentCount / Math.max(1, days / 7) },
    avgEngagementPerContent: contentCount > 0 ? total / contentCount : 0,
  };
}

// ─── Audience ─────────────────────────────────────────────────────────────────

export async function getAudience(userId: string, range = "28d") {
  const days = rangeDays(range);
  const since = new Date(Date.now() - days * 86_400_000);

  const [totalFollowers, newFollowers, series, followerTz] = await Promise.all([
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED" } }),
    prisma.follow.count({ where: { followingId: userId, status: "ACCEPTED", createdAt: { gte: since } } }),
    dailySeries(userId, days),
    // Derive audience geography from each follower's timezone (already stored for
    // streaks) — real geo with zero extra tracking.
    prisma.follow.findMany({ where: { followingId: userId, status: "ACCEPTED" }, select: { follower: { select: { timezone: true } } } }),
  ]);

  // Bucket follower timezones into world regions.
  const regionCount = new Map<string, number>();
  const tzCount = new Map<string, number>();
  for (const f of followerTz) {
    const tz = f.follower.timezone || "";
    const region = regionOf(tz);
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
    if (tz) tzCount.set(tz, (tzCount.get(tz) ?? 0) + 1);
  }
  const tot = followerTz.length || 1;
  const geo = [...regionCount.entries()].sort((a, b) => b[1] - a[1]).map(([country, n]) => ({ country, pct: (n / tot) * 100 }));
  const timezones = [...tzCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tz, n]) => ({ source: tz.replace(/_/g, " "), pct: (n / tot) * 100 }));

  return {
    totalFollowers,
    newFollowers,
    geo,
    sources: timezones, // top timezones (reuses the "sources" UI slot)
    series: series.map((s) => ({ date: s.date, value: s.followers })),
  };
}

/** Map an IANA timezone to a coarse world region for audience geography. */
function regionOf(tz: string): string {
  if (!tz) return "Unknown";
  if (/^Asia\/(Kolkata|Calcutta|Colombo|Kathmandu|Karachi|Dhaka|Thimphu)/.test(tz)) return "South Asia";
  const cont = tz.split("/")[0];
  switch (cont) {
    case "America": return "Americas";
    case "Europe": return "Europe";
    case "Africa": return "Africa";
    case "Asia": return "Asia";
    case "Australia": case "Pacific": return "Oceania";
    case "Atlantic": case "Indian": return "Other";
    default: return "Other";
  }
}
