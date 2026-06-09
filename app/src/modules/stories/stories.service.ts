import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import type { CreateStoryDto } from "./stories.schema";

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  verifiedKind: true,
} as const;

// ─── getFeed — active stories from me + people I follow, grouped by author ────
//
// Order: my group first (rail anchor), then authors with unseen stories
// (newest first), then fully-seen authors. Stories inside a group play oldest
// → newest, IG-style.

export async function getFeed(userId: string) {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  const authorIds = [userId, ...follows.map((f: { followingId: string }) => f.followingId)];

  const stories = await prisma.story.findMany({
    where: {
      authorId: { in: authorIds },
      deletedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: authorSelect },
      views: { where: { userId }, select: { userId: true } },
      _count: { select: { views: true } },
    },
  });

  type Group = {
    author: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
    stories: Array<{
      id: string; mediaUrl: string; mediaType: string; caption: string | null;
      createdAt: Date; expiresAt: Date; viewedByMe: boolean; viewCount: number;
    }>;
    allViewed: boolean;
    latestAt: Date;
  };

  const groups = new Map<string, Group>();
  for (const s of stories) {
    let g = groups.get(s.authorId);
    if (!g) {
      g = { author: s.author, stories: [], allViewed: true, latestAt: s.createdAt };
      groups.set(s.authorId, g);
    }
    const viewedByMe = s.views.length > 0;
    if (!viewedByMe) g.allViewed = false;
    if (s.createdAt > g.latestAt) g.latestAt = s.createdAt;
    g.stories.push({
      id: s.id,
      mediaUrl: s.mediaUrl,
      mediaType: s.mediaType,
      caption: s.caption,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      viewedByMe,
      viewCount: s._count.views,
    });
  }

  const all = [...groups.values()];
  const mine = all.filter((g) => g.author.id === userId);
  const rest = all
    .filter((g) => g.author.id !== userId)
    .sort((a, b) => {
      if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1; // unseen first
      return b.latestAt.getTime() - a.latestAt.getTime();
    });

  return { data: [...mine, ...rest] };
}

// ─── createStory ──────────────────────────────────────────────────────────────

export async function createStory(authorId: string, dto: CreateStoryDto) {
  const story = await prisma.story.create({
    data: {
      authorId,
      mediaUrl: dto.mediaUrl,
      mediaType: dto.mediaType,
      ...(dto.caption ? { caption: dto.caption } : {}),
      expiresAt: new Date(Date.now() + STORY_TTL_MS),
    },
    include: { author: { select: authorSelect } },
  });
  return story;
}

// ─── markViewed (idempotent) ──────────────────────────────────────────────────

export async function markViewed(userId: string, storyId: string) {
  const story = await prisma.story.findUnique({ where: { id: storyId }, select: { id: true, deletedAt: true } });
  if (!story || story.deletedAt) throw notFound("Story not found");
  await prisma.storyView.upsert({
    where: { userId_storyId: { userId, storyId } },
    create: { userId, storyId },
    update: {},
  });
}

// ─── listViewers (owner only) — who saw this Peeak ─────────────────────────────

export async function listViewers(userId: string, storyId: string) {
  const story = await prisma.story.findUnique({ where: { id: storyId }, select: { authorId: true } });
  if (!story) throw notFound("Story not found");
  if (story.authorId !== userId) throw forbidden("Only the author can see viewers");
  const views = await prisma.storyView.findMany({
    where: { storyId },
    orderBy: { viewedAt: "desc" },
    select: { viewedAt: true, user: { select: authorSelect } },
  });
  return { viewers: views.map((v) => ({ ...v.user, viewedAt: v.viewedAt })) };
}

// ─── deleteStory (author only, soft delete) ───────────────────────────────────

export async function deleteStory(userId: string, storyId: string) {
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story || story.deletedAt) throw notFound("Story not found");
  if (story.authorId !== userId) throw forbidden("You can only delete your own stories");
  await prisma.story.update({ where: { id: storyId }, data: { deletedAt: new Date() } });
}
