/**
 * Safelist of admin endpoints that a dashboard widget can pull from.
 * Admins compose widgets by picking a source key + supplying per-source
 * config (e.g. which field to plot). The frontend grid then fetches the
 * resolved URL and renders.
 *
 * Why a safelist instead of "any URL": prevents SSRF, prevents an admin
 * from accidentally fetching expensive endpoints inside a widget loop,
 * and makes the widget kind <-> shape contract explicit.
 */

export interface SourceMeta {
  key:        string                 // identifier persisted on DashboardWidget.source
  label:      string                 // display name in the picker
  url:        string                 // admin endpoint to fetch (relative; api wrapper prepends base)
  kinds:      Array<"stat"|"table"|"chart"|"text">  // widget kinds this source supports
  description: string
  fieldHints?: string[]              // common dot-paths into the JSON response useful for "stat" widgets
}

export const DASHBOARD_SOURCES: SourceMeta[] = [
  { key: "cost.overview",      label: "Cost overview",          url: "/admin/cost/overview?days=7",                kinds: ["stat","table"], description: "Cost spend last 7d, per-endpoint",
    fieldHints: ["totalCostDollars","totalRequests"] },
  { key: "sla.overview",       label: "SLA / RED overview",     url: "/admin/sla/overview?hours=24",               kinds: ["stat","table"], description: "Requests / errors / latency",
    fieldHints: ["endpoints[0].requests","endpoints[0].errorRatePct"] },
  { key: "anomalies.list",     label: "Anomalies (recent)",     url: "/admin/anomalies?onlyOpen=true&limit=25",    kinds: ["stat","table"], description: "Recent open anomalies",
    fieldHints: ["total","counters.impossible_travel"] },
  { key: "incidents.list",     label: "Incidents (open)",       url: "/admin/incidents?status=open",               kinds: ["stat","table"], description: "Currently open incidents",
    fieldHints: ["data.length"] },
  { key: "tickets.open",       label: "Tickets (open)",         url: "/admin/tickets?status=open",                 kinds: ["stat","table"], description: "Open support tickets",
    fieldHints: ["counters.open","counters.in_progress"] },
  { key: "approvals.pending",  label: "Approvals pending",      url: "/admin/approvals?status=pending",            kinds: ["stat","table"], description: "Pending two-person approvals",
    fieldHints: ["counters.pending"] },
  { key: "ai.llm.overview",    label: "LLM ops overview",       url: "/admin/ai/llm/overview?days=7",              kinds: ["stat","table"], description: "LLM cost, errors, latency",
    fieldHints: ["totals.calls","totals.costDollars","totals.errorRatePct"] },
  { key: "logs.recent",        label: "Recent errors (logs)",   url: "/admin/logs?level=error&hours=24",           kinds: ["stat","table"], description: "Recent error logs",
    fieldHints: ["data.length"] },
  { key: "traces.recent",      label: "Recent slow traces",     url: "/admin/traces?minMs=500&hours=24",           kinds: ["stat","table"], description: "Recent spans >500ms",
    fieldHints: ["totals.sampled","totals.p99Ms"] },
  { key: "backups.status",     label: "Backup status",          url: "/admin/backups?days=14",                     kinds: ["stat","table"], description: "Backup recency + verification",
    fieldHints: ["latestByKind.db.ageHours","overdueKinds.length"] },
  { key: "platform.health",    label: "Platform health",        url: "/admin/health",                              kinds: ["stat"],         description: "Overall platform health",
    fieldHints: ["status","uptime"] },
  { key: "stats.overview",     label: "Headline stats",         url: "/admin/stats",                               kinds: ["stat"],         description: "User/post/etc. counts",
    fieldHints: ["users","posts","activeUsers"] },
]

export function isSafeSource(key: string): boolean {
  return DASHBOARD_SOURCES.some(s => s.key === key)
}

export function getSource(key: string): SourceMeta | undefined {
  return DASHBOARD_SOURCES.find(s => s.key === key)
}
