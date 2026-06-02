import { prisma } from "../config/prisma";
import { adminAudit } from "../lib/adminAudit";

/**
 * Data retention sweeper. Reads `security.dataRetentionDays` from AdminSetting
 * (audit / sessions / securityEvents counts in days) and purges anything older.
 *
 * Audit log retention: per spec the AuditLog should be append-only AND have a
 * retention policy. Purging here is the ONLY code path that mutates AuditLog —
 * and even this writes an `audit.retention_purged` summary BEFORE the delete
 * so the action is itself recorded.
 */

const DEFAULTS = { audit: 365, sessions: 90, securityEvents: 365 };

export async function runDataRetention(): Promise<{ purged: Record<string, number> }> {
  const setting = await prisma.adminSetting.findUnique({ where: { key: "security.dataRetentionDays" } });
  const cfg = { ...DEFAULTS, ...((setting?.value as Record<string, number> | undefined) ?? {}) };

  const purged: Record<string, number> = {};

  // 1. Sessions
  if (cfg.sessions > 0) {
    const cutoff = new Date(Date.now() - cfg.sessions * 86_400_000);
    const r = await prisma.refreshToken.deleteMany({ where: { lastUsedAt: { lt: cutoff } } });
    purged.refreshTokens = r.count;
  }

  // 2. Security events (end-user auth)
  if (cfg.securityEvents > 0) {
    const cutoff = new Date(Date.now() - cfg.securityEvents * 86_400_000);
    const r = await prisma.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    purged.securityEvents = r.count;
  }

  // 3. AuditLog — emit the summary FIRST so the purge is traceable.
  if (cfg.audit > 0) {
    const cutoff = new Date(Date.now() - cfg.audit * 86_400_000);
    const willPurge = await prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } });
    if (willPurge > 0) {
      await adminAudit({
        actorId: null,
        action:  "audit.retention_purged",
        metadata: { retentionDays: cfg.audit, cutoffISO: cutoff.toISOString(), purgedCount: willPurge },
      });
      const r = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      purged.auditLog = r.count;
    } else {
      purged.auditLog = 0;
    }
  }

  return { purged };
}
