import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { createNotification, NotificationType } from "../../lib/notify";
import { updateStreak } from "../../lib/streak";
import {
  broadcastPostCreated, broadcastPostLiked, broadcastPostUnliked,
  broadcastPostCommented, broadcastPostDeleted,
} from "../../realtime/broadcast";
import type { CreatePostDto } from "./posts.schema";

// ─── Shared include ───────────────────────────────────────────────────────────

const postInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
  anime: {
    select: {
      id: true,
      malId: true,
      title: true,
      imageUrl: true,
    },
  },
  _count: {
    select: { likes: true, comments: true },
  },
} as const;

// ─── Pagination helper ────────────────────────────────────────────────────────

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

/** Attach isLikedByMe flag to posts when userId is known */
async function withLikeStatus<T extends { id: string }>(posts: T[], userId?: string): Promise<(T & { isLikedByMe: boolean })[]> {
  if (!userId || posts.length === 0) {
    return posts.map(p => ({ ...p, isLikedByMe: false }))
  }
  const likes = await prisma.postLike.findMany({
    where: { userId, postId: { in: posts.map(p => p.id) } },
    select: { postId: true },
  })
  const likedSet = new Set(likes.map((l: { postId: string }) => l.postId))
  return posts.map(p => ({ ...p, isLikedByMe: likedSet.has(p.id) }))
}

// ─── getFeed ──────────────────────────────────────────────────────────────────

export async function getFeed(userId: string, cursor?: string, limit = 20) {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  const authorIds = [userId, ...follows.map((f: { followingId: string }) => f.followingId)];

  const posts = await prisma.post.findMany({
    where: {
      authorId: { in: authorIds },
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: postInclude,
  });

  const hasMore = posts.length > limit;
  const slice = hasMore ? posts.slice(0, limit) : posts;
  const data = await withLikeStatus(slice, userId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getDiscover ──────────────────────────────────────────────────────────────

export async function getDiscover(userId?: string, cursor?: string, limit = 20) {
  const posts = await prisma.post.findMany({
    where: {
      deletedAt: null,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    take: limit + 1,
    orderBy: { createdAt: "desc" },
    include: postInclude,
  });

  const hasMore = posts.length > limit;
  const slice = hasMore ? posts.slice(0, limit) : posts;
  const data = await withLikeStatus(slice, userId);
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getPost ──────────────────────────────────────────────────────────────────

export async function getPost(id: string, userId?: string) {
  const post = await prisma.post.findUnique({
    where: { id },
    include: postInclude,
  });

  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  let liked: boolean | undefined;
  if (userId) {
    const like = await prisma.postLike.findUnique({
      where: { userId_postId: { userId, postId: id } },
    });
    liked = like !== null;
  }

  return { post, liked };
}

// ─── createPost ───────────────────────────────────────────────────────────────

export async function createPost(authorId: string, dto: CreatePostDto) {
  const post = await prisma.post.create({
    data: {
      authorId,
      content: dto.content,
      ...(dto.animeId ? { animeId: dto.animeId } : {}),
    },
    include: postInclude,
  });
  addReputation(authorId, "post_created").catch(console.error);
  void updateStreak(authorId).catch(() => {});

  // Fire-and-forget: notify @mentioned users
  void (async () => {
    const mentionRegex = /\B@(\w+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(dto.content)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length === 0) return;

    const mentionedUsers = await prisma.user.findMany({
      where: { username: { in: mentions } },
      select: { id: true, username: true },
    });

    await Promise.all(
      mentionedUsers
        .filter((u: { id: string; username: string }) => u.id !== authorId)
        .map((u: { id: string; username: string }) =>
          createNotification({
            recipientId: u.id,
            type: NotificationType.MENTION,
            payload: {
              message: `You were mentioned in a post`,
              postId: post.id,
              content: dto.content.slice(0, 100),
            },
          }).catch(console.error),
        ),
    );
  })().catch(console.error);

  // Realtime: broadcast the new post to all connected clients in the feed room
  broadcastPostCreated(post);

  return { post };
}

// ─── deletePost ───────────────────────────────────────────────────────────────

export async function deletePost(id: string, userId: string, userRole: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const canEdit = post.authorId === userId || userRole === "MOD" || userRole === "ADMIN";
  if (!canEdit) throw forbidden("Not allowed to delete this post");

  await prisma.post.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  broadcastPostDeleted(id);
}

// ─── likePost ─────────────────────────────────────────────────────────────────

export async function likePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  // Check if like already exists before awarding reputation
  const existing = await prisma.postLike.findUnique({
    where: { userId_postId: { userId, postId } },
    select: { userId: true },
  });

  await prisma.postLike.upsert({
    where: { userId_postId: { userId, postId } },
    create: { userId, postId },
    update: {},
  });

  // Only award reputation for a new like, not a duplicate
  if (!existing) {
    addReputation(post.authorId, "post_liked").catch(console.error);
  }

  // Realtime: broadcast the new count so all viewers update instantly.
  // Wrapped in try/catch — broadcast failure must not break the core like action.
  try {
    const likes = await prisma.postLike.count({ where: { postId } });
    broadcastPostLiked(postId, post.authorId, likes, userId);
  } catch { /* socket emission is best-effort */ }
}

// ─── unlikePost ───────────────────────────────────────────────────────────────

export async function unlikePost(userId: string, postId: string) {
  await prisma.postLike.deleteMany({ where: { userId, postId } });
  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } });
    if (post) {
      const likes = await prisma.postLike.count({ where: { postId } });
      broadcastPostUnliked(postId, post.authorId, likes);
    }
  } catch { /* best-effort broadcast */ }
}

// ─── getComments ─────────────────────────────────────────────────────────────

export async function getComments(postId: string, page = 1, limit = 20) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const { skip, take } = paginate(page, limit);

  const [data, total] = await prisma.$transaction([
    prisma.postComment.findMany({
      where: { postId },
      skip,
      take,
      orderBy: { createdAt: "asc" },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    }),
    prisma.postComment.count({ where: { postId } }),
  ]);

  return { data, meta: meta(total, page, limit) };
}

// ─── createComment ────────────────────────────────────────────────────────────

export async function createComment(postId: string, authorId: string, content: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const comment = await prisma.postComment.create({
    data: { postId, authorId, content },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  });

  // Realtime: broadcast new comment count (best-effort)
  try {
    const comments = await prisma.postComment.count({ where: { postId } });
    broadcastPostCommented(postId, post.authorId, comments);
  } catch { /* fire-and-forget */ }

  return { comment };
}
