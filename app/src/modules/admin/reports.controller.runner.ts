// Shared report runner extracted so jobs can import without pulling in
// the full Express controller (and its Request/Response types).
import { prisma } from "../../config/prisma";

const REPORTS = ["signups", "active-users-7d", "moderation-backlog", "audit-summary", "billing-revenue"] as const;
type ReportKey = typeof REPORTS[number] | string;

interface GeneratedReport { columns: string[]; rows: Record<string, unknown>[] }

export async function runReport(key: ReportKey): Promise<GeneratedReport> {
  switch (key) {
    case "signups": {
      const rows = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*)::bigint AS count
        FROM "User"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1 DESC`;
      return { columns: ["day", "count"], rows: rows.map(r => ({ day: r.day.toISOString().slice(0, 10), count: Number(r.count) })) };
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
      return { columns: ["status", "count"], rows: counts.map(c => ({ status: c.status, count: c._count._all })) };
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
      return { columns: ["day", "totalCents"], rows: rows.map(r => ({ day: r.day?.toISOString().slice(0, 10), totalCents: Number(r.total) })) };
    }
    default:
      throw new Error(`Unknown report: ${key}`);
  }
}
