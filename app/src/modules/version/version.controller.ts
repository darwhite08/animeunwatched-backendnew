import { NextFunction, Request, Response } from "express";
import * as service from "./version.service";

export function get(_req: Request, res: Response, next: NextFunction): void {
  try {
    res.status(200).json(service.getVersion());
  } catch (err) {
    next(err);
  }
}
