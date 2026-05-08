import { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badReq } from "../../lib/errors";

type SearchType = "anime" | "posts" | "users" | "blogs";

function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query.q as string | undefined;
    if (!q || q.trim() === "") {
      throw badReq("Query parameter 'q' is required");
    }

    const type = (req.query.type as SearchType) || "anime";
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const { skip, take } = paginate(page, limit);

    let data: unknown[];
    let total: number;

    switch (type) {
      case "anime": {
        const where = {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { synopsis: { contains: q, mode: "insensitive" as const } },
          ],
        };
        [data, total] = await prisma.$transaction([
          prisma.anime.findMany({
            where,
            skip,
            take,
            orderBy: { score: "desc" },
            select: {
              id: true,
              malId: true,
              title: true,
              titleEnglish: true,
              imageUrl: true,
              score: true,
              type: true,
              status: true,
            },
          }),
          prisma.anime.count({ where }),
        ]);
        break;
      }

      case "posts": {
        const where = {
          content: { contains: q, mode: "insensitive" as const },
          deletedAt: null,
        };
        [data, total] = await prisma.$transaction([
          prisma.post.findMany({
            where,
            skip,
            take,
            orderBy: { createdAt: "desc" },
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
          prisma.post.count({ where }),
        ]);
        break;
      }

      case "users": {
        const where = {
          OR: [
            { username: { contains: q, mode: "insensitive" as const } },
            { displayName: { contains: q, mode: "insensitive" as const } },
          ],
        };
        [data, total] = await prisma.$transaction([
          prisma.user.findMany({
            where,
            skip,
            take,
            orderBy: { reputation: "desc" },
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              reputation: true,
            },
          }),
          prisma.user.count({ where }),
        ]);
        break;
      }

      case "blogs": {
        const where = {
          status: "PUBLISHED" as const,
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { body: { contains: q, mode: "insensitive" as const } },
          ],
        };
        [data, total] = await prisma.$transaction([
          prisma.blog.findMany({
            where,
            skip,
            take,
            orderBy: { publishedAt: "desc" },
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
          prisma.blog.count({ where }),
        ]);
        break;
      }

      default:
        throw badReq("Invalid type. Must be one of: anime, posts, users, blogs");
    }

    res.status(200).json({ data, meta: meta(total, page, limit) });
  } catch (err) {
    next(err);
  }
}
