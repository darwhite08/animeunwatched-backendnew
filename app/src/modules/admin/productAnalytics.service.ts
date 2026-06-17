import { prisma } from "../../config/prisma"

/**
 * Product analytics for the admin dashboard — activation + retention, answerable
 * for web vs mobile via User.signupPlatform. All metrics are derived live in SQL
 * from the domain tables (no event store): signup = User.createdAt, list-add =
 * ListEntry.createdAt, post = Post.createdAt, "active/reopened" = a UNION of
 * action timestamps across Post / ListEntry / PostLike / PostComment / Activity.
 *
 * `platform` ∈ "all" | "web" | "mobile" | "unknown". When not "all" we compare
 * COALESCE(signupPlatform,'unknown') so legacy (null) rows bucket as "unknown".
 */

export type Platform = "all" | "web" | "mobile" | "unknown"

export function normalizePlatform(raw: unknown): Platform {
  return raw === "web" || raw === "mobile" || raw === "unknown" ? raw : "all"
}

/**
 * Activation funnel for the signup cohort of the last `days` days:
 *   signed up → added ≥1 anime to list → created ≥1 post
 * Each stage is a strict subset of the previous (so it shows true drop-off).
 */
export async function getActivationFunnel(opts: { days: number; platform: Platform }) {
  const days = Math.min(180, Math.max(1, Math.floor(opts.days || 7)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const all = opts.platform === "all"
  const platform = all ? "" : opts.platform

  const rows = await prisma.$queryRaw<Array<{
    signed_up: bigint; added_list: bigint; posted: bigint
  }>>`
    WITH cohort AS (
      SELECT u.id
      FROM "User" u
      WHERE u."createdAt" >= ${since}::timestamptz
        AND (${all}::boolean OR COALESCE(u."signupPlatform", 'unknown') = ${platform}::text)
    ),
    added AS (
      SELECT DISTINCT c.id
      FROM cohort c
      JOIN "ListEntry" le ON le."userId" = c.id
    ),
    posted AS (
      SELECT DISTINCT a.id
      FROM added a
      JOIN "Post" p ON p."authorId" = a.id AND p."deletedAt" IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM cohort)::bigint AS signed_up,
      (SELECT COUNT(*) FROM added)::bigint  AS added_list,
      (SELECT COUNT(*) FROM posted)::bigint AS posted
  `
  const r = rows[0] ?? { signed_up: 0n, added_list: 0n, posted: 0n }
  const signedUp = Number(r.signed_up)
  const addedList = Number(r.added_list)
  const posted = Number(r.posted)
  const pct = (n: number) => (signedUp ? Math.round((n / signedUp) * 100) : 0)

  return {
    rangeDays: days,
    platform: opts.platform,
    // Shape matches the admin FunnelChart (stage/users/pct).
    stages: [
      { stage: "Signed up", users: signedUp, pct: 100 },
      { stage: "Added ≥1 anime to list", users: addedList, pct: pct(addedList) },
      { stage: "Created ≥1 post", users: posted, pct: pct(posted) },
    ],
    // Step-to-step conversion (where the drop-off actually happens).
    conversion: {
      signupToList: pct(addedList),
      listToPost: addedList ? Math.round((posted / addedList) * 100) : 0,
    },
  }
}

/**
 * Per-signup-week cohorts (last `weeks` weeks): cohort size, activation
 * (≥1 list-add within 24h of signup), reopened-since-signup, and D1/D7 retention.
 * "Active on day N" = any action in [signup + N days, signup + N+1 days).
 */
export async function getCohorts(opts: { weeks: number; platform: Platform }) {
  const weeks = Math.min(26, Math.max(1, Math.floor(opts.weeks || 8)))
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
  const all = opts.platform === "all"
  const platform = all ? "" : opts.platform

  const rows = await prisma.$queryRaw<Array<{
    week: string; week_start: Date; cohort_size: bigint
    activated_24h: bigint; returned: bigint; d1: bigint; d7: bigint
  }>>`
    WITH cohort AS (
      SELECT u.id, u."createdAt" AS signup_at, date_trunc('week', u."createdAt") AS wk
      FROM "User" u
      WHERE u."createdAt" >= date_trunc('week', ${since}::timestamptz)
        AND (${all}::boolean OR COALESCE(u."signupPlatform", 'unknown') = ${platform}::text)
    ),
    acts AS (
      SELECT "authorId" AS uid, "createdAt" AS ts FROM "Post"        WHERE "deletedAt" IS NULL AND "createdAt" >= ${since}::timestamptz
      UNION ALL
      SELECT "userId",   "createdAt"        FROM "ListEntry"   WHERE "createdAt" >= ${since}::timestamptz
      UNION ALL
      SELECT "userId",   "createdAt"        FROM "PostLike"    WHERE "createdAt" >= ${since}::timestamptz
      UNION ALL
      SELECT "authorId", "createdAt"        FROM "PostComment" WHERE "createdAt" >= ${since}::timestamptz
      UNION ALL
      SELECT "authorId", "createdAt"        FROM "Activity"    WHERE "deletedAt" IS NULL AND "createdAt" >= ${since}::timestamptz
    ),
    activated AS (
      SELECT DISTINCT c.id FROM cohort c
      JOIN "ListEntry" le ON le."userId" = c.id
        AND le."createdAt" >= c.signup_at
        AND le."createdAt" <  c.signup_at + interval '24 hours'
    ),
    returned AS (
      SELECT DISTINCT c.id FROM cohort c
      JOIN acts a ON a.uid = c.id AND a.ts >= c.signup_at + interval '1 day'
    ),
    d1 AS (
      SELECT DISTINCT c.id FROM cohort c
      JOIN acts a ON a.uid = c.id
        AND a.ts >= c.signup_at + interval '1 day' AND a.ts < c.signup_at + interval '2 day'
    ),
    d7 AS (
      SELECT DISTINCT c.id FROM cohort c
      JOIN acts a ON a.uid = c.id
        AND a.ts >= c.signup_at + interval '7 day' AND a.ts < c.signup_at + interval '8 day'
    )
    SELECT
      to_char(c.wk, 'IYYY-"W"IW') AS week,
      c.wk::date                  AS week_start,
      COUNT(DISTINCT c.id)::bigint                                  AS cohort_size,
      COUNT(DISTINCT activated.id)::bigint                          AS activated_24h,
      COUNT(DISTINCT returned.id)::bigint                           AS returned,
      COUNT(DISTINCT d1.id)::bigint                                 AS d1,
      COUNT(DISTINCT d7.id)::bigint                                 AS d7
    FROM cohort c
    LEFT JOIN activated ON activated.id = c.id
    LEFT JOIN returned  ON returned.id  = c.id
    LEFT JOIN d1        ON d1.id        = c.id
    LEFT JOIN d7        ON d7.id        = c.id
    GROUP BY c.wk
    ORDER BY c.wk DESC
  `

  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)

  return {
    weeks,
    platform: opts.platform,
    cohorts: rows.map((r) => {
      const size = Number(r.cohort_size)
      const start = r.week_start.getTime()
      return {
        week: r.week,
        weekStart: r.week_start.toISOString().slice(0, 10),
        cohortSize: size,
        activated24h: Number(r.activated_24h),
        activated24hPct: pct(Number(r.activated_24h), size),
        returned: Number(r.returned),
        returnedPct: pct(Number(r.returned), size),
        d1: Number(r.d1),
        d1Pct: pct(Number(r.d1), size),
        d7: Number(r.d7),
        d7Pct: pct(Number(r.d7), size),
        // A window is "mature" only once enough time has elapsed for every user
        // in it to have had the chance to hit that day — otherwise the % is
        // understated and should be shown as provisional.
        d1Mature: now - start >= 9 * DAY,   // week fully aged + 2 days
        d7Mature: now - start >= 15 * DAY,  // week fully aged + 8 days
      }
    }),
  }
}
