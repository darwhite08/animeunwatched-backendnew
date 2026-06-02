import { prisma } from "../config/prisma";

/**
 * Composite per-user risk score (0–100). Used by the admin user-detail
 * page to give mods at-a-glance "is this account suspicious?" signal
 * without having to read 50 audit rows themselves.
 *
 * Each signal contributes a fixed weight; total is capped at 100.
 * Pure function of recent SecurityEvent + User fields — no separate
 * cache, computed on demand because it's cheap.
 */
export interface RiskBreakdown {
  score:    number              // 0–100
  level:    "low" | "moderate" | "high" | "critical"
  signals: Array<{
    code:   string
    label:  string
    weight: number
  }>
}

interface RiskSignal { code: string; label: string; weight: number; when: boolean }

export async function computeUserRisk(userId: string): Promise<RiskBreakdown> {
  const since30d = new Date(Date.now() - 30 * 86_400_000);
  const since24h = new Date(Date.now() - 86_400_000);

  const [user, eventsRecent, distinctIps, recentReports] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, isBanned: true, isShadowBanned: true, createdAt: true, role: true },
    }),
    prisma.securityEvent.findMany({
      where:   { userId, createdAt: { gte: since30d } },
      select:  { type: true, ipAddress: true, createdAt: true },
    }),
    prisma.securityEvent.findMany({
      where:   { userId, ipAddress: { not: null } },
      select:  { ipAddress: true },
      distinct: ["ipAddress"],
    }),
    prisma.report.count({
      where: { targetType: "User", targetId: userId, createdAt: { gte: since30d } },
    }),
  ]);

  if (!user) return { score: 0, level: "low", signals: [] };

  const failedLogins24h = eventsRecent.filter(e => e.type === "login_failed" && e.createdAt > since24h).length;
  const failedLogins30d = eventsRecent.filter(e => e.type === "login_failed").length;
  const passwordResets30d = eventsRecent.filter(e => e.type === "password_reset_completed").length;
  const csrfFailures30d   = eventsRecent.filter(e => e.type === "csrf_failure").length;
  const rateLimitTrips30d = eventsRecent.filter(e => e.type === "rate_limit_tripped").length;
  const accountAgeDays    = (Date.now() - user.createdAt.getTime()) / 86_400_000;

  const candidates: RiskSignal[] = [
    { code: "banned",            label: "Account is banned",                    weight: 40, when: user.isBanned },
    { code: "shadow_banned",     label: "Account is shadow-banned",             weight: 30, when: user.isShadowBanned },
    { code: "many_failed_24h",   label: `${failedLogins24h} failed logins in 24h`, weight: 25, when: failedLogins24h >= 5 },
    { code: "many_failed_30d",   label: `${failedLogins30d} failed logins in 30d`, weight: 15, when: failedLogins30d >= 15 },
    { code: "frequent_pwd_reset",label: `${passwordResets30d} password resets in 30d`, weight: 15, when: passwordResets30d >= 2 },
    { code: "csrf",              label: `${csrfFailures30d} CSRF failures in 30d`,     weight: 20, when: csrfFailures30d >= 1 },
    { code: "rate_limit",        label: `${rateLimitTrips30d} rate-limit trips`,       weight: 10, when: rateLimitTrips30d >= 3 },
    { code: "many_ips",          label: `${distinctIps.length} distinct IPs ever`,     weight: 15, when: distinctIps.length >= 8 },
    { code: "new_account",       label: `Account < 1 day old`,                         weight: 5,  when: accountAgeDays < 1 },
    { code: "reported_30d",      label: `${recentReports} user reports in 30d`,        weight: 20, when: recentReports >= 3 },
  ];

  const signals = candidates.filter(c => c.when);
  const score   = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  const level   = score >= 70 ? "critical" : score >= 40 ? "high" : score >= 15 ? "moderate" : "low";

  return {
    score,
    level,
    signals: signals.map(({ code, label, weight }) => ({ code, label, weight })),
  };
}
