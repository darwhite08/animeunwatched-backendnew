/**
 * Streak day-boundary + transition math — the anti-frustration core
 * (docs/streak-algorithm.md). Verifies the three churn bugs are fixed:
 * timezone-correct boundary, grace window, and freeze/soft-break instead of
 * hard reset.
 */
import { describe, it, expect } from "vitest";
import {
  crossedMilestones,
  dayDiff,
  decideTransition,
  freezesEarned,
  streakDateKey,
} from "../app/src/lib/streakMath";

describe("streakDateKey — timezone + grace", () => {
  it("uses the user's local calendar date, not UTC", () => {
    // 2026-06-07 23:30 UTC is already 2026-06-08 05:00 in IST (UTC+5:30).
    const at = new Date("2026-06-07T23:30:00Z");
    expect(streakDateKey(at, "Asia/Kolkata")).toBe("2026-06-08");
    expect(streakDateKey(at, "UTC")).toBe("2026-06-07");
  });

  it("grace window: early-morning activity counts as the previous day", () => {
    // 02:00 IST on the 8th → grace-shifted back into the 7th.
    const at = new Date("2026-06-07T20:30:00Z"); // = 2026-06-08 02:00 IST
    expect(streakDateKey(at, "Asia/Kolkata")).toBe("2026-06-07");
  });

  it("invalid tz falls back to UTC without throwing", () => {
    expect(streakDateKey(new Date("2026-06-07T12:00:00Z"), "Not/AZone")).toBe("2026-06-07");
  });
});

describe("dayDiff", () => {
  it("counts whole days between keys", () => {
    expect(dayDiff("2026-06-07", "2026-06-08")).toBe(1);
    expect(dayDiff("2026-06-07", "2026-06-07")).toBe(0);
    expect(dayDiff("2026-06-01", "2026-06-11")).toBe(10);
  });
});

describe("decideTransition", () => {
  const base = { today: "2026-06-08", streakDays: 10, freezes: 0 };

  it("first activity ever", () => {
    expect(decideTransition({ ...base, lastStreakDate: null }).kind).toBe("first");
  });
  it("same day → no change", () => {
    expect(decideTransition({ ...base, lastStreakDate: "2026-06-08" }).kind).toBe("same-day");
  });
  it("consecutive day → extend", () => {
    expect(decideTransition({ ...base, lastStreakDate: "2026-06-07" }).kind).toBe("extend");
  });
  it("missed one day with a freeze → freeze (streak survives)", () => {
    const t = decideTransition({ ...base, lastStreakDate: "2026-06-06", freezes: 1 });
    expect(t).toEqual({ kind: "freeze", missed: 1 });
  });
  it("missed one day with NO freeze → break (not a hard reset elsewhere)", () => {
    expect(decideTransition({ ...base, lastStreakDate: "2026-06-06", freezes: 0 }).kind).toBe("break");
  });
  it("missed three days, only two freezes → break", () => {
    expect(decideTransition({ ...base, lastStreakDate: "2026-06-04", freezes: 2 }).kind).toBe("break");
  });
  it("missed three days with three freezes → freeze", () => {
    expect(decideTransition({ ...base, lastStreakDate: "2026-06-04", freezes: 3 })).toEqual({ kind: "freeze", missed: 3 });
  });
});

describe("milestones & freeze earning", () => {
  it("flags milestones newly crossed", () => {
    expect(crossedMilestones(6, 7)).toEqual([7]);
    expect(crossedMilestones(29, 30)).toEqual([30]);
    expect(crossedMilestones(7, 8)).toEqual([]);
    expect(crossedMilestones(0, 1)).toEqual([]);
  });
  it("earns one freeze per 7-day boundary crossed", () => {
    expect(freezesEarned(6, 7)).toBe(1);
    expect(freezesEarned(7, 8)).toBe(0);
    expect(freezesEarned(13, 14)).toBe(1);
    expect(freezesEarned(0, 1)).toBe(0);
  });
});
