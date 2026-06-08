# Kaiveron — Streak Algorithm (hook without the frustration)

> Goal: maximize the loss-aversion "hook" of a daily streak **while removing
> every avoidable source of rage-quit**. The mechanic that retains is *fear of
> losing a long streak*; the mechanic that churns users is *losing it to a
> technicality* (wrong timezone, one busy day, an app glitch). This design
> keeps the first and kills the second.

Grounded in the retention research:
- **Loss aversion grows with streak length** — a 180-day user is driven by *not losing 180*, not by reaching 181. The system must make a long streak feel precious **and** safe.
- **Forgiveness mechanics (freezes, grace, repair) increase long-term persistence** — Duolingo added streak freezes *because* broken streaks devastated users. Flexibility is not cheating; it's what makes streaks sustainable.
- **Low-friction, meaningful daily action** — one genuine action per day, not "open the app," not a 30-minute grind.
- **Variable milestone rewards** keep it fresh; **timely "at-risk" nudges** trigger the loss-aversion loop *before* the loss, not after.

---

## 0. What's wrong with the current implementation

`lib/streak.ts` today:
```ts
const todayStr = now.toISOString().slice(0, 10);   // ❌ UTC day boundary
if (daysSinceLast === 1) newStreak = +1; else newStreak = 1;  // ❌ instant hard reset
```
Three guaranteed frustrations:
1. **UTC midnight** — an IST user active at 11:30pm local is already "tomorrow" in UTC (05:00); their next-evening session can read as a 2-day gap → **streak lost while being perfectly consistent.**
2. **No grace** — miss midnight by 10 minutes → streak gone.
3. **Hard reset to 1, no recovery** — one bad day nukes 100 days with no freeze and no repair. This is the #1 churn event.

The design below fixes all three.

---

## 1. Data model

**Extend `User`:**
```prisma
streakDays        Int       @default(0)   // current streak (exists)
bestStreak        Int       @default(0)   // exists
lastActiveAt      DateTime?               // last qualifying activity ts (exists)
lastStreakDate    String?                 // local-day key "YYYY-MM-DD" streak was last credited  ← the real comparison key
timezone          String    @default("Asia/Kolkata")  // per-user day boundary
streakFreezes     Int       @default(0)   // held freeze tokens (auto-consumed)
freezeGrantedAt   DateTime?               // weekly earn-cap anchor
streakRepairAt    DateTime?               // last free repair (monthly cap)
streakBrokenAt    DateTime?               // when the last break happened (repair window)
prevStreakDays    Int       @default(0)   // streak value just before a break (for repair)
```

**New `StreakDay`** (one row per user per active local day — powers the Consistency Map heatmap and is the audit trail):
```prisma
model StreakDay {
  userId        String
  date          String     // local-day key "YYYY-MM-DD"
  activityCount Int        @default(1)
  source        String                    // "frozen" | "grace" | "activity"
  createdAt     DateTime   @default(now())
  @@id([userId, date])
  @@index([userId, date])
}
```

Everything is **O(1) per activity**: one `User` read+update + one `StreakDay` upsert. No history scan ever.

---

## 2. The day boundary — timezone + grace (fixes frustrations #1, #2)

A "streak day" is the calendar date **in the user's timezone**, with a **grace window**: activity before `GRACE_HOURS` (default **04:00**) counts toward the *previous* day (night owls finishing "yesterday" at 2am don't lose it).

```ts
const GRACE_HOURS = 4;

function streakDateKey(at: Date, tz: string): string {
  // shift back so 00:00–03:59 local belongs to the previous calendar day
  const shifted = new Date(at.getTime() - GRACE_HOURS * 3_600_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(shifted); // YYYY-MM-DD
}

function dayDiff(a: string, b: string): number {       // whole days between two day-keys
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
```

---

## 3. Core algorithm — `recordActivity(userId)`

Called whenever a user performs a **qualifying action** (§6). Forgiveness is applied
in cheapest-first order: **same-day → consecutive → grace → freeze → break(→repairable)**.

```ts
const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365]; // +every 100 after
const MAX_FREEZES = 5;

async function recordActivity(userId: string, now = new Date()) {
  const u = await getUser(userId);                 // streakDays, lastStreakDate, tz, streakFreezes…
  const today = streakDateKey(now, u.timezone);

  // (a) already credited today → just bump the day's activity count, no streak change
  if (u.lastStreakDate === today) {
    await bumpStreakDay(userId, today);
    return { streak: u.streakDays, changed: false };
  }

  // first ever
  if (!u.lastStreakDate) return start(userId, today, now);

  const gap = dayDiff(u.lastStreakDate, today);     // days since last credited day

  // (b) consecutive day → extend
  if (gap === 1) return extend(userId, u, today, now, "activity");

  // (c) one or more missed days → cover them with freezes if possible
  const missed = gap - 1;                           // days with no activity
  if (missed > 0 && u.streakFreezes >= missed && u.streakDays > 0) {
    await consumeFreezes(userId, missed);           // auto-equip, like Duolingo
    await fillFrozenDays(userId, u.lastStreakDate, missed); // StreakDay rows marked "frozen"
    return extend(userId, u, today, now, "activity"); // streak survives, +1 for today
  }

  // (d) break — but SOFT: today counts as 1, prior streak is stashed for repair
  return breakStreak(userId, u, today, now);
}

async function extend(userId, u, today, now, source) {
  const streak = u.streakDays + 1;
  await update(userId, {
    streakDays: streak,
    bestStreak: Math.max(streak, u.bestStreak),
    lastStreakDate: today,
    lastActiveAt: now,
  });
  await upsertStreakDay(userId, today, source);
  await maybeAwardMilestone(userId, streak);        // §4
  return { streak, changed: true };
}

async function breakStreak(userId, u, today, now) {
  await update(userId, {
    prevStreakDays: u.streakDays,                   // remember for repair
    streakBrokenAt: now,
    streakDays: 1,                                  // today still counts — never start from 0
    lastStreakDate: today,
    lastActiveAt: now,
  });
  await upsertStreakDay(userId, today, "activity");
  return { streak: 1, changed: true, broke: true, repairable: true };
}
```

---

## 4. Freeze economy + milestones (the hook, variable reward)

**Earning freezes** (auto-consumed, never manually fiddly):
- +1 freeze each time the user **crosses a 7-day boundary** (7, 14, 21…), capped at `MAX_FREEZES = 5` held.
- Optional: +1 for a perfect 7/7 week. Cap prevents hoarding-then-vanishing.

**Milestone rewards** — variable so it stays fresh:
```
day 3   → "Spark" badge
day 7   → badge + 1 freeze + small reputation bump
day 14  → badge + 1 freeze
day 30  → "Committed" badge + reputation + profile flair
day 100 → "Centurion" badge + 2 freezes + cosmetic
day 365 → "Ascendant" badge + perks
```
Milestones grant **reputation** (ties into the existing gamification system: 7-day streak already = +10 rep) and badges; the *variety* of reward (badge vs freeze vs cosmetic vs rep) is the variable-reward hook.

---

## 5. Repair — forgiveness after a real break (fixes frustration #3)

Even with freezes, sometimes a long streak breaks. Without recovery, that user churns. So:

- When a streak breaks, we stash `prevStreakDays` + `streakBrokenAt`.
- For **48h** after the break, the user is offered a one-tap **"Restore your N-day streak."**
- Cost model (tiered, anti-abuse):
  - **1 free repair per month** (`streakRepairAt` cap), OR
  - spend earned freezes / reputation, OR
  - (future) a premium perk.
- Repair restores `streakDays = prevStreakDays + (days bridged)` and back-fills the gap `StreakDay` rows as `source:"repair"`.

This single feature converts the worst churn moment (losing 100 days) into a re-engagement moment.

---

## 6. What counts as a "qualifying activity" (low friction, anti-gaming)

One **meaningful** action per day credits the streak — not "opened the app," not something grindy:
- logged an episode watched (`ListEntry.episodesSeen` advanced), marked completed, rated
- posted / commented / reviewed / created or voted in a poll / meaningful thread reply

Rules:
- **One credit per local day** (multiple actions just bump `activityCount`, no extra streak).
- Trivial/no-op actions (page views, opening the app, liking your own content) **don't** qualify.
- Hook `recordActivity` into the existing service calls that already fire `updateStreak`, but gate on the action being one of the qualifying set.

---

## 7. Anti-frustration "at-risk" nudge (loss-aversion, timed)

A daily batched job (existing `jobRegistry`, **not** per-request) at each user's local evening:
- If the user has a streak ≥ 2 and **hasn't** credited today and local time ≥ **18:00**, send a "🔥 Your N-day streak is at risk" push/notification (uses the existing notification + push stack; the retention-engine doc wants this within the daily window).
- If a streak just broke and is repairable, send a "Restore your N-day streak" nudge.

This fires the loss-aversion loop **before** the loss — the humane, effective version.

---

## 8. Server efficiency

- **Per activity:** 1 indexed `User` read + 1 update + 1 `StreakDay` upsert → O(1), a few hundred µs. No scans, no Redis.
- **Heatmap (Consistency Map):** `SELECT date, activityCount FROM StreakDay WHERE userId=? AND date >= ?` — one indexed range scan for the last ~365 days.
- **At-risk nudges:** one batched daily job over users with `streakDays >= 2 AND lastStreakDate < today`, chunked — not in the request path.
- **Freeze grants & milestones:** computed inline at the moment a boundary is crossed; no separate sweep.

---

## 9. Why this hooks without frustrating

| Hook (retention) | Anti-frustration (anti-churn) |
|---|---|
| Loss aversion scales with streak length | Timezone-correct + 4h grace → never lose it to a clock |
| Variable milestone rewards (badges, freezes, rep, cosmetics) | Auto-freezes absorb the occasional missed day |
| "At-risk" nudge fires the loss-loop before loss | Soft break (today = 1, never 0) + 48h repair |
| Best-streak is permanent, always visible | One free repair/month so a real-life week off isn't fatal |
| Streak Society perks for long streaks (future: weekly rest day) | Clear, honest "what counts" — no guessing |

The asymmetry is deliberate: **make the streak feel precious (hook) but hard to lose by accident (anti-frustration).** That's the exact balance the research says maximizes long-term persistence.

---

## 10. Rollout

1. **Phase 1:** fix the day boundary (tz + grace) and the soft-break in `lib/streak.ts` + add the `User` fields and `StreakDay` table. This alone removes the worst churn bugs.
2. **Phase 2:** freeze economy + auto-consume + milestone rewards (wire into reputation/badges).
3. **Phase 3:** repair flow + at-risk nudges (notification/push job) + Consistency-Map endpoint for the heatmap.
4. **Phase 4 (optional):** Streak Society (weekly rest day for long streaks), per-region leaderboards.
