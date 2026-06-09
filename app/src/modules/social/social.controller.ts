import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import * as service from "./social.service";

/** Public — confirms which providers are configured on the server (no secrets). */
export async function health(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    instagram: { configured: service.instagramAvailable() },
    tiktok: { configured: service.tiktokAvailable() },
    redirectConfigured: Boolean(env.INSTAGRAM_REDIRECT_URI || env.TIKTOK_REDIRECT_URI || env.OAUTH_CALLBACK_BASE),
  });
}

export async function getConnections(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.listConnections(res.locals.user.id)); } catch (err) { next(err); }
}

export async function startInstagram(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(service.startInstagramConnect(res.locals.user.id)); } catch (err) { next(err); }
}

/** Public — Instagram redirects the browser here after the user authorizes. */
export async function instagramCallback(req: Request, res: Response): Promise<void> {
  const studio = env.CREATOR_STUDIO_URL.replace(/\/$/, "");
  try {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (req.query.error || !code) { res.redirect(`${studio}/shots?ig=denied`); return; }
    await service.handleInstagramCallback(code, state);
    res.redirect(`${studio}/shots?ig=connected`);
  } catch {
    res.redirect(`${studio}/shots?ig=error`);
  }
}

export async function getReels(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.listInstagramReels(res.locals.user.id)); } catch (err) { next(err); }
}

const importSchema = z.object({ mediaIds: z.array(z.string()).min(1).max(25) });

export async function importReels(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mediaIds } = importSchema.parse(req.body);
    res.status(200).json(await service.importInstagramReels(res.locals.user.id, mediaIds));
  } catch (err) { next(err); }
}

export async function disconnectInstagram(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.disconnectInstagram(res.locals.user.id)); } catch (err) { next(err); }
}

// ─── TikTok ──────────────────────────────────────────────────────────────────

export async function startTiktok(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(service.startTiktokConnect(res.locals.user.id)); } catch (err) { next(err); }
}

/** Public — TikTok redirects the browser here after the user authorizes. */
export async function tiktokCallback(req: Request, res: Response): Promise<void> {
  const studio = env.CREATOR_STUDIO_URL.replace(/\/$/, "");
  try {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (req.query.error || !code) { res.redirect(`${studio}/shots?tt=denied`); return; }
    await service.handleTiktokCallback(code, state);
    res.redirect(`${studio}/shots?tt=connected`);
  } catch {
    res.redirect(`${studio}/shots?tt=error`);
  }
}

export async function getTiktokVideos(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.listTiktokVideos(res.locals.user.id)); } catch (err) { next(err); }
}

export async function importTiktok(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mediaIds } = importSchema.parse(req.body);
    res.status(200).json(await service.importTiktokVideos(res.locals.user.id, mediaIds));
  } catch (err) { next(err); }
}

export async function disconnectTiktok(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.disconnectTiktok(res.locals.user.id)); } catch (err) { next(err); }
}
