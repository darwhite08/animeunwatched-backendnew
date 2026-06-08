import { Request, Response, NextFunction } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./links.service";

export async function preview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (!url) throw badRequest("url query param is required");
    res.status(200).json(await service.unfurl(url));
  } catch (err) { next(err); }
}
