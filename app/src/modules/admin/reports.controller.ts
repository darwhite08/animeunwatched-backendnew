import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * M13 — saved & scheduled reports.
 *
 * `reportKey` identifies a built-in generator (see runReport switch below).
 * Generators return rows-of-objects + a column list. Format CSV is rendered
 * inline; JSON returns raw.
 *
 * Schedules run via a daily cron tick that finds `enabled` rows whose `cron`
 * matched in the last 24h. Without SMTP wiring the run still produces output
 * and stores its location in AdminSetting under key `report.lastRun.<scheduleId>`.
 */

const REPORTS = ["signups", "active-users-7d", "moderation-backlog", "audit-summary", "billing-revenue"] as const;
export type ReportKey = typeof REPORTS[number];

interface GeneratedReport { columns: string[]; rows: Record<string, unknown>[] }

async function runReport(key: ReportKey): Promise<GeneratedReport> {
  switch (key) {
    case "signups": {
      const rows = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*)::bigint AS count
        FROM "User"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1 DESC`;
      return {
        columns: ["day", "count"],
        rows: rows.map(r => ({ day: r.day.toISOString().slice(0, 10), count: Number(r.count) })),
      };
    }
    case "active-users-7d": {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count
        FROM "SecurityEvent"
        WHERE "type" = 'login_success' AND "createdAt" >= NOW() - INTERVAL '7 days'`;
      return { columns: ["activeUsers7d"], rows: [{ activeUsers7d: Number(rows[0]?.count ?? 0) }] };
    }
    case "moderation-backlog": {
      const counts = await prisma.moderationItem.groupBy({ by: ["status"], _count: { _all: true } });
      return {
        columns: ["status", "count"],
        rows: counts.map(c => ({ status: c.status, count: c._count._all })),
      };
    }
    case "audit-summary": {
      const rows = await prisma.$queryRaw<Array<{ action: string; count: bigint }>>`
        SELECT "action", COUNT(*)::bigint AS count
        FROM "AuditLog"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 50`;
      return { columns: ["action", "count"], rows: rows.map(r => ({ action: r.action, count: Number(r.count) })) };
    }
    case "billing-revenue": {
      const rows = await prisma.$queryRaw<Array<{ day: Date; total: bigint }>>`
        SELECT date_trunc('day', "paidAt")::date AS day, SUM("amountCents")::bigint AS total
        FROM "Invoice"
        WHERE "status" = 'PAID' AND "paidAt" >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1 DESC`;
      return {
        columns: ["day", "totalCents"],
        rows: rows.map(r => ({ day: r.day?.toISOString().slice(0, 10), totalCents: Number(r.total) })),
      };
    }
  }
}

function csv(report: GeneratedReport): string {
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [report.columns.join(","), ...report.rows.map(r => report.columns.map(c => escape(r[c])).join(","))].join("\n");
}

export function listReportNames(_req: Request, res: Response): void {
  res.status(200).json({ data: REPORTS });
}

export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const name = req.params.name as ReportKey;
    if (!REPORTS.includes(name)) throw badRequest(`Unknown report. Allowed: ${REPORTS.join(", ")}`);
    const result = await runReport(name);
    await adminAuditR(req, res, { action: "report.viewed", targetId: name, metadata: { rows: result.rows.length } });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function exportReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const name = req.params.name as ReportKey;
    if (!REPORTS.includes(name)) throw badRequest(`Unknown report. Allowed: ${REPORTS.join(", ")}`);
    const format = typeof req.query.format === "string" ? req.query.format : "csv";
    const result = await runReport(name);
    await adminAuditR(req, res, { action: "report.exported", targetId: name, metadata: { format, rows: result.rows.length } });

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${name}-${Date.now()}.json"`);
      res.status(200).send(JSON.stringify(result, null, 2));
    } else {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${name}-${Date.now()}.csv"`);
      res.status(200).send(csv(result));
    }
  } catch (err) { next(err); }
}

// ── Schedules ────────────────────────────────────────────────────────────────

export async function listSchedules(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.reportSchedule.findMany({ orderBy: { createdAt: "desc" } });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function createSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { name, reportKey, cron, format, recipients, enabled } = req.body as Record<string, unknown>;
    if (typeof name !== "string" || typeof reportKey !== "string" || typeof cron !== "string") {
      throw badRequest("name, reportKey, cron required");
    }
    if (!REPORTS.includes(reportKey as ReportKey)) throw badRequest(`Unknown reportKey. Allowed: ${REPORTS.join(", ")}`);

    const sched = await prisma.reportSchedule.create({
      data: {
        name, reportKey, cron,
        format:     typeof format === "string" ? format : "csv",
        recipients: (recipients ?? []) as never,
        enabled:    enabled !== false,
        createdBy:  actorId,
      },
    });
    await adminAuditR(req, res, {
      action: "report.schedule_create", targetType: "ReportSchedule", targetId: sched.id,
      metadata: { name, reportKey, cron },
    });
    res.status(200).json({ schedule: sched });
  } catch (err) { next(err); }
}

export async function deleteSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const sched = await prisma.reportSchedule.findUnique({ where: { id } });
    if (!sched) throw notFound("Schedule not found");
    await prisma.reportSchedule.delete({ where: { id } });
    await adminAuditR(req, res, {
      action: "report.schedule_delete", targetType: "ReportSchedule", targetId: id,
      metadata: { name: sched.name, reportKey: sched.reportKey },
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function runScheduleNow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const sched = await prisma.reportSchedule.findUnique({ where: { id } });
    if (!sched) throw notFound("Schedule not found");
    const { runOneSchedule } = await import("../../jobs/reportScheduler.job");
    const outcome = await runOneSchedule(sched.reportKey, sched.format, (sched.recipients as string[]) ?? [], sched.name);
    const status = outcome.failed > 0
      ? `partial:rowcount=${outcome.rows},sent=${outcome.delivered},dryRun=${outcome.dryRun},failed=${outcome.failed}`
      : `ok:rowcount=${outcome.rows},sent=${outcome.delivered}${outcome.dryRun ? `,dryRun=${outcome.dryRun}` : ""}`;
    await prisma.reportSchedule.update({
      where: { id },
      data:  { lastRunAt: new Date(), lastResult: status },
    });
    await adminAuditR(req, res, {
      action: "report.schedule_run", targetType: "ReportSchedule", targetId: id,
      metadata: { reportKey: sched.reportKey, ...outcome },
    });
    res.status(200).json({ ok: true, outcome });
  } catch (err) { next(err); }
}
