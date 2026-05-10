import { prisma } from "../../config/prisma";
import { notFound, forbidden } from "../../lib/errors";
import { addReputation } from "../../lib/reputation";
import { createNotification, NotificationType } from "../../lib/notify";
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
  const data = hasMore ? posts.slice(0, limit) : posts;
  const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

  return { data, meta: { nextCursor } };
}

// ─── getDiscover ──────────────────────────────────────────────────────────────

export async function getDiscover(cursor?: string, limit = 20) {
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
  const data = hasMore ? posts.slice(0, limit) : posts;
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
  })();

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
}

// ─── likePost ─────────────────────────────────────────────────────────────────

export async function likePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt !== null) throw notFound("Post not found");

  await prisma.postLike.upsert({
    where: { userId_postId: { userId, postId } },
    create: { userId, postId },
    update: {},
  });
  addReputation(post.authorId, "post_liked").catch(console.error);
}

// ─── unlikePost ───────────────────────────────────────────────────────────────

export async function unlikePost(userId: string, postId: string) {
  await prisma.postLike.deleteMany({ where: { userId, postId } });
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

  return { comment };
}
