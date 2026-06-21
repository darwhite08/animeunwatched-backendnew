import { Request, Response, NextFunction } from "express";
import { browseQuerySchema } from "./anime.schema";
import * as service from "./anime.service";
import { resolveWatchSources, watchSourcesEnabled } from "./watchSources.service";
import { YouTubeQuotaError } from "./youtubeTrailer.service";
import { badReq } from "../../lib/errors";

const VALID_SEASONS = ["winter", "spring", "summer", "fall"] as const;
type Season = typeof VALID_SEASONS[number];

const VALID_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export async function getSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const day = String(req.params.day ?? "").toLowerCase();
    if (!VALID_DAYS.includes(day as typeof VALID_DAYS[number])) throw badReq("day must be a weekday name");
    res.status(200).json(await service.getSchedule(day as typeof VALID_DAYS[number]));
  } catch (err) {
    next(err);
  }
}

function parseMalId(raw: string | string[]): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(str, 10);
  if (isNaN(id) || id <= 0) throw badReq("malId must be a positive integer");
  return id;
}

export async function browse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = browseQuerySchema.parse(req.query);
    const result = await service.browse(query);
    res.status(200).json(result);
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

export async function getAnimeUserStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId);
    const result = await service.getAnimeUserStats(malId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Array.isArray(req.params.malId) ? req.params.malId[0] : req.params.malId;
    const userId: string | undefined = res.locals.user?.id;
    // Numeric → malId (canonical, used by all existing clients); anything
    // else → SEO slug ("fullmetal-alchemist-brotherhood").
    const result = /^\d+$/.test(raw)
      ? await service.getById(parseMalId(raw), userId)
      : await service.getBySlug(raw, userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /anime/:malId/watch-sources — official, embeddable full episodes (best-effort). */
export async function getWatchSources(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Array.isArray(req.params.malId) ? req.params.malId[0] : req.params.malId;
    if (!/^\d+$/.test(raw)) throw badReq("watch-sources requires a numeric malId");
    if (!watchSourcesEnabled()) { res.status(200).json({ sources: [], enabled: false }); return; }
    const sources = await resolveWatchSources(parseInt(raw, 10));
    res.status(200).json({ sources, enabled: true });
  } catch (err) {
    // Quota exhaustion is expected/transient — degrade to empty, don't 500.
    if (err instanceof YouTubeQuotaError) { res.status(200).json({ sources: [], enabled: true, quota: true }); return; }
    next(err);
  }
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    if (!q) throw badReq("Query parameter 'q' is required");
    const result = await service.searchWithFallback(q);
    // flattenAnime normalises genres/studios to string[] matching the browse endpoint shape
    const data = result.map(a => service.flattenAnimePublic(a));
    res.status(200).json({ data, meta: { total: data.length } });
  } catch (err) {
    next(err);
  }
}

export async function getSeasonal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const yearStr = Array.isArray(req.params.year) ? req.params.year[0] : req.params.year;
    const year = parseInt(yearStr, 10);
    if (isNaN(year) || year < 1900 || year > new Date().getFullYear() + 2) {
      throw badReq("year must be a valid 4-digit year");
    }
    const season = req.params.season as string;
    if (!VALID_SEASONS.includes(season as Season)) {
      throw badReq(`season must be one of: ${VALID_SEASONS.join(", ")}`);
    }
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const result = await service.getSeasonal(year, season as Season, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getTrailers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(60, Number(req.query.limit) || 30);
    res.status(200).json({ data: await service.getTrailers(limit) });
  } catch (err) { next(err); }
}

export async function getTrending(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const result = await service.getTrending(limit);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getSimilar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId);
    const limit = Math.min(50, Number(req.query.limit) || 12);
    const userId: string | undefined = res.locals.user?.id;
    const result = await service.getSimilar(malId, limit, userId);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getForYou(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const result = await service.getForYou(userId, limit);
    res.status(200).json({ data: result, meta: { algorithm: "for-you-v1" } });
  } catch (err) {
    next(err);
  }
}

export async function getCharacters(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId)
    const data = await service.getCharacters(malId)
    res.status(200).json(data)
  } catch (err) { next(err) }
}

export async function getStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId)
    const data = await service.getStaff(malId)
    res.status(200).json(data)
  } catch (err) { next(err) }
}

export async function getEpisodes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId)
    const page  = Number(req.query.page) || 1
    const data  = await service.getEpisodes(malId, page)
    res.status(200).json(data)
  } catch (err) { next(err) }
}

export async function getFranchise(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = parseMalId(req.params.malId)
    const data  = await service.getFranchise(malId)
    res.status(200).json(data)
  } catch (err) { next(err) }
}

export async function listGenres(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    res.status(200).json({ data: await service.listGenres(limit) })
  } catch (err) { next(err) }
}

export async function listStudios(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    res.status(200).json({ data: await service.listStudios(limit) })
  } catch (err) { next(err) }
}
