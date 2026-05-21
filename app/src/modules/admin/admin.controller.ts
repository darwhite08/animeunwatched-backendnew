import { Request, Response, NextFunction } from "express";
import * as service from "./admin.service";

export async function getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getStats();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getRecentUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const result = await service.getRecentUsers(limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPlatformHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getPlatformHealth();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page   = Number(req.query.page)   || 1
    const limit  = Number(req.query.limit)  || 20
    const status = req.query.status as string | undefined
    const result = await service.listReports(page, limit, status)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function resolveReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const reportId = req.params.reportId as string
    const { status }   = req.body as { status: "RESOLVED" | "DISMISSED" }
    const modId        = res.locals.user?.id as string
    const result       = await service.resolveReport(reportId, status, modId)
    res.status(200).json(result)
  } catch (err) { next(err) }
}
