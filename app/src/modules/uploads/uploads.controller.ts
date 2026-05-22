import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./uploads.service";
import { avatarUploadSchema, postImageUploadSchema } from "./uploads.schema";

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
