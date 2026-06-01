/**
 * One-shot backfill: copy every existing Post into Activity as kind=TEXT.
 *
 * Idempotent — uses Activity.id = "post:" + Post.id as a deterministic key,
 * so re-runs skip rows that already exist (via createMany skipDuplicates).
 *
 * Engagement counters (likeCount, replyCount) are recomputed from the source
 * PostLike + PostComment tables so they match. repostCount stays 0 because
 * the old Post model had no repost concept.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/backfill-activities.ts
 */
import { prisma } from "../app/src/config/prisma";

async function main() {
  console.log("[backfill] starting Post → Activity migration");

  const posts = await prisma.post.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      authorId: true,
      content: true,
      animeId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[backfill] found ${posts.length} live posts to migrate`);
  if (posts.length === 0) {
    console.log("[backfill] nothing to do — exiting");
    return;
  }

  const rows = posts.map((p) => ({
    id:            `post:${p.id}`,
    authorId:      p.authorId,
    kind:          "TEXT" as const,
    body:          p.content,
    linkedAnimeId: p.animeId,
    likeCount:     p._count.likes,
    repostCount:   0,
    replyCount:    p._count.comments,
    createdAt:     p.createdAt,
    updatedAt:     p.updatedAt,
  }));

  const result = await prisma.activity.createMany({
    data:           rows,
    skipDuplicates: true,
  });

  console.log(`[backfill] inserted ${result.count} new Activity rows (existing rows skipped)`);
  console.log("[backfill] done");
}

main()
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
