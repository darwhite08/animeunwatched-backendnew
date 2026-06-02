import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * M2 — login history. Reads SecurityEvent rows filtered to the auth-related
 * types for a specific user. Includes per-event IP + user-agent.
 *
 * Auditied on read because this exposes PII (IPs the user signed in from).
 */

const AUTH_TYPES = [
  "login_success", "login_failed", "register",
  "password_changed", "password_reset_completed", "password_reset_requested",
  "session_revoked", "logout_all", "oauth_login", "oauth_handoff",
];

export async function getLoginHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string;
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const events = await prisma.securityEvent.findMany({
      where:   { userId, type: { in: AUTH_TYPES } },
      orderBy: { createdAt: "desc" },
      take:    limit,
      select:  { id: true, type: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true },
    });

    // Distinct IP list with first/last seen — useful for spotting suspicious patterns
    const ipMap = new Map<string, { ip: string; firstSeen: Date; lastSeen: Date; count: number }>();
    for (const e of events) {
      if (!e.ipAddress) continue;
      const v = ipMap.get(e.ipAddress);
      if (v) {
        v.count++;
        if (e.createdAt < v.firstSeen) v.firstSeen = e.createdAt;
        if (e.createdAt > v.lastSeen)  v.lastSeen  = e.createdAt;
      } else {
        ipMap.set(e.ipAddress, { ip: e.ipAddress, firstSeen: e.createdAt, lastSeen: e.createdAt, count: 1 });
      }
    }

    await adminAuditR(req, res, {
      action: "user.login_history_viewed", targetType: "User", targetId: userId,
      metadata: { eventCount: events.length, uniqueIPs: ipMap.size },
    });

    res.status(200).json({
      events,
      ipSummary: Array.from(ipMap.values()).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime()),
    });
  } catch (err) { next(err); }
}
