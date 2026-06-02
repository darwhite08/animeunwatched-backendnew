import type { Request, Response, NextFunction } from "express";
import { listJobs, runJob } from "../../lib/jobRegistry";
import { badRequest } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

export function getJobs(_req: Request, res: Response, next: NextFunction): void {
  try {
    res.status(200).json({ data: listJobs() });
  } catch (err) { next(err); }
}

export async function retryJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const name = req.params.name as string;
    if (!name) throw badRequest("job name required");
    await runJob(name);
    await adminAuditR(req, res, {
      action: "job.manual_run", targetType: "Job", targetId: name,
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
