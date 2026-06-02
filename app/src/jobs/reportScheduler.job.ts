import { prisma } from "../config/prisma";
import { sendMail } from "../lib/mailer";

/**
 * Report schedule runner — fires every hour. For each enabled schedule whose
 * cron expression matches the current UTC hour and hasn't already run today,
 * generates the report, renders it in the schedule's format, and emails it
 * to each recipient.
 *
 * Without SMTP configured the mailer returns dryRun:true; the schedule still
 * records lastResult as ok so it doesn't infinitely retry.
 *
 * Cron parsing is intentionally minimal — we only support `0 H * * *`
 * (daily at UTC hour H). Anything more complex degrades to the hour at
 * position 1 of the cron string.
 */

function reportToCsv(report: { columns: string[]; rows: Record<string, unknown>[] }): string {
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [report.columns.join(","), ...report.rows.map(r => report.columns.map(c => escape(r[c])).join(","))].join("\n");
}

interface RunOutcome {
  rows:       number;
  delivered:  number;
  dryRun:     number;
  failed:     number;
  errors:     string[];
}

async function runOneSchedule(
  reportKey:  string,
  format:     string,
  recipients: string[],
  scheduleName: string,
): Promise<RunOutcome> {
  const { runReport } = await import("../modules/admin/reports.controller.runner");
  const report = await runReport(reportKey);

  let content: string;
  let contentType: string;
  let filename: string;
  if (format === "json") {
    content = JSON.stringify(report, null, 2);
    contentType = "application/json";
    filename = `${reportKey}-${new Date().toISOString().slice(0, 10)}.json`;
  } else {
    content = reportToCsv(report);
    contentType = "text/csv";
    filename = `${reportKey}-${new Date().toISOString().slice(0, 10)}.csv`;
  }

  const outcome: RunOutcome = { rows: report.rows.length, delivered: 0, dryRun: 0, failed: 0, errors: [] };

  if (recipients.length === 0) return outcome;

  for (const to of recipients) {
    const r = await sendMail({
      to,
      subject:  `[Kaiveron] ${scheduleName} — ${report.rows.length} rows`,
      text:     `Report "${reportKey}" generated at ${new Date().toISOString()}.\n${report.rows.length} rows attached as ${filename}.`,
      attachments: [{ filename, content, contentType }],
      tag:      "report",
    });
    if (r.dryRun)         outcome.dryRun++;
    else if (r.ok)        outcome.delivered++;
    else { outcome.failed++; if (r.error) outcome.errors.push(r.error) }
  }

  return outcome;
}

export async function runReportScheduler(): Promise<{ ran: number }> {
  const schedules = await prisma.reportSchedule.findMany({ where: { enabled: true } });
  let ran = 0;
  const now = new Date();
  for (const s of schedules) {
    const dueHour = Number(s.cron.split(" ")[1] ?? "0");
    if (now.getUTCHours() !== dueHour) continue;
    if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < 23 * 60 * 60 * 1000) continue;

    try {
      const outcome = await runOneSchedule(s.reportKey, s.format, (s.recipients as string[]) ?? [], s.name);
      const status = outcome.failed > 0
        ? `partial:rowcount=${outcome.rows},sent=${outcome.delivered},dryRun=${outcome.dryRun},failed=${outcome.failed}`
        : `ok:rowcount=${outcome.rows},sent=${outcome.delivered}${outcome.dryRun ? `,dryRun=${outcome.dryRun}` : ""}`;
      await prisma.reportSchedule.update({
        where: { id: s.id },
        data:  { lastRunAt: now, lastResult: status },
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

/** Exposed so the /admin/reports/schedules/:id/run handler can email too. */
export { runOneSchedule };
