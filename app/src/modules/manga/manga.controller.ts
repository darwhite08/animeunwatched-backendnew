import { Request, Response, NextFunction } from "express";
import { browseMangaQuerySchema } from "./manga.schema";
import * as service from "./manga.service";
import { badReq } from "../../lib/errors";

function parseMalId(raw: string | string[]): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(str, 10);
  if (isNaN(id) || id <= 0) throw badReq("malId must be a positive integer");
  return id;
}

export async function browse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = browseMangaQuerySchema.parse(req.query);
    res.status(200).json(await service.browse(query));
  } catch (err) {
    next(err);
  }
}

export async function getSitemap(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await service.getSitemapEntries();
    res.status(200).json({ data, meta: { total: data.length } });
  } catch (err) {
    next(err);
  }
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    if (!q) throw badReq("Query parameter 'q' is required");
    const result = await service.searchWithFallback(q);
    const data = result.map((m) => service.flattenMangaPublic(m));
    res.status(200).json({ data, meta: { total: data.length } });
  } catch (err) {
    next(err);
  }
}

/** POST /manga/request-title — record a "not in our catalog yet" request. */
export async function requestTitle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = String((req.body as { query?: unknown; q?: unknown })?.query ?? (req.body as { q?: unknown })?.q ?? "").trim();
    if (!q) throw badReq("Query is required");
    res.status(200).json(await service.requestMissingTitle(q.slice(0, 200)));
  } catch (err) {
    next(err);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Array.isArray(req.params.malId) ? req.params.malId[0] : req.params.malId;
    const userId: string | undefined = res.locals.user?.id;
    // Numeric → malId (canonical); anything else → SEO slug.
    const result = /^\d+$/.test(raw)
      ? await service.getById(parseMalId(raw), userId)
      : await service.getBySlug(raw, userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getMangaUserStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId);
    res.status(200).json(await service.getMangaUserStats(malId));
  } catch (err) {
    next(err);
  }
}

export async function listGenres(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.status(200).json({ data: await service.listGenres(limit) });
  } catch (err) {
    next(err);
  }
}
