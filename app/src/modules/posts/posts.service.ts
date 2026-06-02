import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { createNotification, NotificationType } from "../../lib/notify";
import { updateStreak } from "../../lib/streak";
import { auditDelete } from "../../lib/audit";
import {
  broadcastPostCreated, broadcastPostLiked, broadcastPostUnliked,
  broadcastAdminPostCreated, broadcastAdminPostDeleted,
  broadcastPostCommented, broadcastPostDeleted, broadcastPostComment,
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
      ...(dto.animeId  ? { animeId:  dto.animeId  } : {}),
      ...(dto.imageUrl ? { imageUrl: dto.imageUrl } : {}),
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
  broadcastAdminPostCreated();

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

  auditDelete("post_deleted", {
    actorId:    userId,
    targetType: "Post",
    targetId:   id,
    extra: post.authorId !== userId ? { byMod: true, originalAuthorId: post.authorId } : undefined,
  });

  broadcastPostDeleted(id);
  broadcastAdminPostDeleted(id, userId);
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

// ─── Comment helpers ─────────────────────────────────────────────────────────

const COMMENT_AUTHOR_SELECT = {
  id: true, username: true, displayName: true, avatarUrl: true,
} as const;

async function attachCommentLikeStatus<T extends { id: string }>(comments: T[], userId?: string) {
  if (!userId || comments.length === 0) return comments.map(c => ({ ...c, isLikedByMe: false }));
  const likes = await prisma.postCommentLike.findMany({
    where: { userId, commentId: { in: comments.map(c => c.id) } },
    select: { commentId: true },
  });
  const set = new Set(likes.map((l: { commentId: string }) => l.commentId));
  return comments.map(c => ({ ...c, isLikedByMe: set.has(c.id) }));
}

// ─── getComments ─────────────────────────────────────────────────────────────
//
// Returns TOP-LEVEL comments (parentCommentId IS NULL) on a post, each with
// the FIRST FEW nested replies inline (thread-string preview). Deeper levels
// must be fetched via getCommentReplies.

const REPLIES_INLINE = 3;

export async function getComments(postId: string, page = 1, limit = 20, viewerId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  const { skip, take } = paginate(page, limit);

  const [topLevel, total] = await prisma.$transaction([
    prisma.postComment.findMany({
      where: { postId, parentCommentId: null },
      skip,
      take,
      orderBy: { createdAt: "asc" },
      include: {
        author:  { select: COMMENT_AUTHOR_SELECT },
        replies: {
          take: REPLIES_INLINE,
          orderBy: { createdAt: "asc" },
          include: { author: { select: COMMENT_AUTHOR_SELECT } },
        },
      },
    }),
    prisma.postComment.count({ where: { postId, parentCommentId: null } }),
  ]);

  // Attach isLikedByMe to BOTH top-level + inline replies
  const allIds = topLevel.flatMap(c => [c.id, ...c.replies.map(r => r.id)]);
  const likedSet = new Set<string>();
  if (viewerId && allIds.length > 0) {
    const likes = await prisma.postCommentLike.findMany({
      where: { userId: viewerId, commentId: { in: allIds } },
      select: { commentId: true },
    });
    for (const l of likes) likedSet.add(l.commentId);
  }
  const data = topLevel.map(c => ({
    ...c,
    isLikedByMe: likedSet.has(c.id),
    replies: c.replies.map(r => ({ ...r, isLikedByMe: likedSet.has(r.id) })),
  }));

  return { data, meta: meta(total, page, limit) };
}

// ─── getCommentReplies ───────────────────────────────────────────────────────
// Page-paginated replies for a single parent comment (used by "View N more").

export async function getCommentReplies(commentId: string, page = 1, limit = 20, viewerId?: string) {
  const parent = await prisma.postComment.findUnique({ where: { id: commentId }, select: { id: true } });
  if (!parent) throw notFound("Comment not found");

  const { skip, take } = paginate(page, limit);
  const [rows, total] = await prisma.$transaction([
    prisma.postComment.findMany({
      where: { parentCommentId: commentId },
      skip, take,
      orderBy: { createdAt: "asc" },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
    }),
    prisma.postComment.count({ where: { parentCommentId: commentId } }),
  ]);
  const data = await attachCommentLikeStatus(rows, viewerId);
  return { data, meta: meta(total, page, limit) };
}

// ─── createComment ────────────────────────────────────────────────────────────

export async function createComment(postId: string, authorId: string, content: string, parentCommentId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  if (parentCommentId) {
    const parent = await prisma.postComment.findUnique({
      where: { id: parentCommentId },
      select: { postId: true },
    });
    if (!parent || parent.postId !== postId) throw notFound("Parent comment not found");
  }

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.postComment.create({
      data: {
        postId, authorId, content,
        parentCommentId: parentCommentId ?? null,
      },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
    });
    if (parentCommentId) {
      await tx.postComment.update({
        where: { id: parentCommentId },
        data:  { replyCount: { increment: 1 } },
      });
    }
    return created;
  });

  // Realtime: broadcast new top-level comment count (replies don't bump the
  // post's headline count — they live under their parent thread).
  try {
    if (!parentCommentId) {
      const comments = await prisma.postComment.count({ where: { postId, parentCommentId: null } });
      broadcastPostCommented(postId, post.authorId, comments);
    }
    broadcastPostComment(postId, comment);
  } catch { /* fire-and-forget */ }

  return { comment: { ...comment, isLikedByMe: false, likeCount: 0, replyCount: 0, replies: [] } };
}

// ─── like / unlike a comment ─────────────────────────────────────────────────

export async function likeComment(userId: string, commentId: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.postComment.findUnique({ where: { id: commentId }, select: { id: true } });
    if (!c) throw notFound("Comment not found");
    try {
      await tx.postCommentLike.create({ data: { userId, commentId } });
      await tx.postComment.update({
        where: { id: commentId },
        data:  { likeCount: { increment: 1 } },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return { ok: true, alreadyLiked: true };
      throw err;
    }
    return { ok: true };
  });
}

export async function unlikeComment(userId: string, commentId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.postCommentLike.findUnique({
      where: { userId_commentId: { userId, commentId } },
    });
    if (!existing) return { ok: true, alreadyUnliked: true };
    await tx.postCommentLike.delete({
      where: { userId_commentId: { userId, commentId } },
    });
    await tx.postComment.update({
      where: { id: commentId },
      data:  { likeCount: { decrement: 1 } },
    });
    return { ok: true };
  });
}
