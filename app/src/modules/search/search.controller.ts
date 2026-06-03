import { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badReq } from "../../lib/errors";
import { titleRelevance, bodyRelevance, logNormalize } from "../../lib/ranking";

type SearchType = "anime" | "posts" | "users" | "blogs" | "clubs" | "threads" | "reviews";

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
        // Multi-signal relevance ranking, computed JS-side after a wide
        // SQL net cast. We grab up to 200 textual matches, then rank in
        // memory using titleRelevance (100 exact / 50 prefix / 30 word /
        // 15 substring) + body match (≤5) + log-normalised quality.
        //
        // 200 is plenty for the small-catalog case; once the DB grows
        // beyond ~10k matching candidates we should switch to Postgres
        // full-text + tsrank — see `searchRankExpr` in lib/ranking.ts.
        const where = {
          OR: [
            { title:        { contains: q, mode: "insensitive" as const } },
            { titleEnglish: { contains: q, mode: "insensitive" as const } },
            { synopsis:     { contains: q, mode: "insensitive" as const } },
          ],
        };
        const total = await prisma.anime.count({ where });
        const candidates = await prisma.anime.findMany({
          where, take: 200,
          select: {
            id: true, malId: true, title: true, titleEnglish: true,
            synopsis: true, imageUrl: true, score: true, type: true, status: true,
          },
        });

        const ranked = candidates
          .map(a => {
            const tScore = Math.max(
              titleRelevance(a.title, q),
              titleRelevance(a.titleEnglish ?? "", q) * 0.9, // English title slightly discounted
            );
            const bScore = bodyRelevance(a.synopsis, q);
            const qBoost = logNormalize(Math.round((a.score ?? 0) * 10), 100) * 8;
            const airing = a.status === "AIRING" ? 2 : 0;
            return { row: a, score: tScore + bScore + qBoost + airing };
          })
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(skip, skip + take)
          .map(({ row }) => {
            // Drop synopsis from the response (it wasn't in the original
            // shape — only used for scoring).
            const { synopsis: _drop, ...rest } = row;
            void _drop;
            return rest;
          });

        res.status(200).json({ data: ranked, meta: meta(total, page, limit) });
        return;
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

      case "clubs": {
        const where = {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
          ],
        };
        [data, total] = await prisma.$transaction([
          prisma.club.findMany({
            where,
            skip,
            take,
            orderBy: { reputation: "desc" },
            include: {
              owner: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  avatarUrl: true,
                },
              },
              _count: { select: { members: true, threads: true } },
            },
          }),
          prisma.club.count({ where }),
        ]);
        break;
      }

      case "threads": {
        const where = {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { content: { contains: q, mode: "insensitive" as const } },
          ],
        };
        [data, total] = await prisma.$transaction([
          prisma.thread.findMany({
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
              _count: { select: { replies: true } },
            },
          }),
          prisma.thread.count({ where }),
        ]);
        break;
      }

      case "reviews": {
        const results = await prisma.review.findMany({
          where: { body: { contains: q, mode: "insensitive" } },
          include: {
            author: { select: { id: true, username: true, displayName: true } },
            anime: { select: { id: true, malId: true, title: true } },
          },
          take: limit,
          skip,
        });
        const total = await prisma.review.count({
          where: { body: { contains: q, mode: "insensitive" } },
        });
        res.json({ data: results, meta: meta(total, page, limit) });
        return;
      }

      default:
        throw badReq("Invalid type. Must be one of: anime, posts, users, blogs, clubs, threads, reviews");
    }

    res.status(200).json({ data, meta: meta(total, page, limit) });
  } catch (err) {
    next(err);
  }
}

export async function suggestions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query.q as string | undefined;
    if (!q || q.trim() === "") {
      throw badReq("Query parameter 'q' is required");
    }

    const [anime, users] = await prisma.$transaction([
      prisma.anime.findMany({
        where: {
          title: { contains: q, mode: "insensitive" },
        },
        take: 3,
        orderBy: { score: "desc" },
        select: {
          malId: true,
          title: true,
          imageUrl: true,
        },
      }),
      prisma.user.findMany({
        where: {
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 2,
        orderBy: { reputation: "desc" },
        select: {
          username: true,
          displayName: true,
        },
      }),
    ]);

    res.status(200).json({ anime, users });
  } catch (err) {
    next(err);
  }
}
