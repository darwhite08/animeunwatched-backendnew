/**
 * Tiny CSV serializer — escapes per RFC 4180 (double-quote any field with
 * comma/quote/newline; double existing quotes). Avoids adding a dep.
 */

function escapeField(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") return escapeField(JSON.stringify(v))
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns?: string[]): string {
  if (rows.length === 0) return columns ? columns.join(",") + "\n" : ""
  const cols = columns ?? Array.from(
    rows.reduce<Set<string>>((s, r) => { for (const k of Object.keys(r)) s.add(k); return s }, new Set()),
  )
  const header = cols.map(escapeField).join(",")
  const body = rows.map(r => cols.map(c => escapeField(r[c])).join(",")).join("\n")
  return header + "\n" + body + "\n"
}
