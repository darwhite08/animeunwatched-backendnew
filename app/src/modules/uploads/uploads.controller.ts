import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./uploads.service";
import { uploadImageBuffer } from "../../lib/storage";
import {
  avatarUploadSchema,
  postImageUploadSchema,
  voiceUploadSchema,
} from "./uploads.schema";

const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
const MAX_BYTES = { avatar: 5 * 1024 * 1024, post: 10 * 1024 * 1024 } as const

function extFor(ct: string): string {
  if (ct === "image/jpeg") return "jpg"
  if (ct === "image/png")  return "png"
  if (ct === "image/webp") return "webp"
  if (ct === "image/gif")  return "gif"
  return "bin"
}

/**
 * Fallback: client POSTs the raw image bytes here when direct-to-S3
 * presigned PUT can't go through (extension blockers, strict CSP,
 * corporate proxy). We then upload server-side and hand back the same
 * { publicUrl, key } shape the presigned flow uses.
 *
 * Mounted with express.raw() so req.body is a Buffer. Scope comes from
 * the query string to keep the body purely the image.
 */
export async function uploadProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id
    const scope = req.query.scope === "avatar" ? "avatar" : req.query.scope === "post" ? "post" : null
    if (!scope) throw badRequest("scope must be 'avatar' or 'post'")

    const contentType = req.header("content-type") ?? ""
    if (!ALLOWED_IMG.has(contentType)) throw badRequest("Only JPEG/PNG/WebP/GIF images are accepted")

    const body = req.body as Buffer | undefined
    if (!body || !Buffer.isBuffer(body) || body.length === 0) throw badRequest("Empty body")
    if (body.length > MAX_BYTES[scope]) {
      throw badRequest(`Image too large — max ${MAX_BYTES[scope] / 1024 / 1024}MB`)
    }

    const result = await uploadImageBuffer({
      userId,
      scope,
      contentType,
      ext: extFor(contentType),
      body,
    })
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

export async function avatar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = avatarUploadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid image payload");
    const intent = await service.presignAvatar({
      userId,
      contentType: parsed.data.contentType,
    });
    res.status(200).json(intent);
  } catch (err) {
    next(err);
  }
}

export async function postImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = postImageUploadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid image payload");
    const intent = await service.presignPostImage({
      userId,
      contentType: parsed.data.contentType,
    });
    res.status(200).json(intent);
  } catch (err) {
    next(err);
  }
}

export async function voice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = voiceUploadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid audio payload");
    const intent = await service.presignVoiceMessage({
      userId,
      contentType: parsed.data.contentType,
    });
    res.status(200).json(intent);
  } catch (err) {
    next(err);
  }
}
