import { prisma } from "../config/prisma";

/**
 * Report schedule runner — fires every hour. For each enabled schedule whose
 * cron expression hasn't been run in the last 24h, kicks the report generator
 * and updates lastRunAt. Without SMTP integration the result rowcount is
 * recorded; the actual rows can be exported on demand from /reports/:name.
 *
 * Cron parsing is intentionally minimal — we only support `0 H * * *` (daily
 * at hour H) for now. Anything more complex degrades to "run once per day at
 * the hour stored in `cron.split(' ')[1]`".
 */

export async function runReportScheduler(): Promise<{ ran: number }> {
  const schedules = await prisma.reportSchedule.findMany({ where: { enabled: true } });
  let ran = 0;
  const now = new Date();
  for (const s of schedules) {
    const dueHour = Number(s.cron.split(" ")[1] ?? "0");
    if (now.getUTCHours() !== dueHour) continue;
    if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < 23 * 60 * 60 * 1000) continue;

    try {
      // Delegate to the controller's runReport logic via dynamic import to avoid cycles.
      const { runReport } = await import("../modules/admin/reports.controller.runner");
      const result = await runReport(s.reportKey);
      await prisma.reportSchedule.update({
        where: { id: s.id },
        data:  { lastRunAt: now, lastResult: `ok:rowcount=${result.rows.length}` },
      });
      ran++;
    } catch (err) {
      await prisma.reportSchedule.update({
        where: { id: s.id },
        data:  { lastRunAt: now, lastResult: `error:${(err as Error).message.slice(0, 200)}` },
      });
    }
  }
  return { ran };
}
