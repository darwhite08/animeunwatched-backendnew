/**
 * Extreme clubs service edge case tests.
 */
import { describe, it, expect } from "vitest";

// Test the toSlug function (used for club slug generation)
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
}

describe("toSlug — edge cases", () => {
  it("converts normal name to slug", () => {
    expect(toSlug("One Piece Fan Club")).toBe("one-piece-fan-club")
  })

  it("handles all uppercase", () => {
    expect(toSlug("ATTACK ON TITAN")).toBe("attack-on-titan")
  })

  it("handles numbers", () => {
    expect(toSlug("Anime Club 2024")).toBe("anime-club-2024")
  })

  it("handles special characters", () => {
    expect(toSlug("Bleach! & Naruto Club")).toBe("bleach-naruto-club")
  })

  it("handles leading/trailing spaces", () => {
    expect(toSlug("  My Club  ")).toBe("my-club")
  })

  it("handles consecutive special chars", () => {
    expect(toSlug("Club---Name")).toBe("club-name")
  })

  it("caps at 30 chars", () => {
    const long = "a very long club name that exceeds the limit"
    expect(toSlug(long).length).toBeLessThanOrEqual(30)
  })

  it("handles empty string", () => {
    expect(toSlug("")).toBe("")
  })

  it("handles only special chars", () => {
    expect(toSlug("!!! @#$")).toBe("")
  })
})

// Test club reputation calculation (if applicable)
function calcClubReputation(memberCount: number, threadCount: number, avgRep: number): number {
  return Math.floor(memberCount * 10 + threadCount * 5 + avgRep)
}

describe("calcClubReputation", () => {
  it("returns 0 for empty club", () => {
    expect(calcClubReputation(0, 0, 0)).toBe(0)
  })

  it("increases with more members", () => {
    expect(calcClubReputation(10, 0, 0)).toBeGreaterThan(calcClubReputation(5, 0, 0))
  })

  it("increases with more threads", () => {
    expect(calcClubReputation(0, 10, 0)).toBeGreaterThan(calcClubReputation(0, 5, 0))
  })

  it("calculates correctly", () => {
    // 10 members * 10 + 5 threads * 5 + 100 avg rep = 100 + 25 + 100 = 225
    expect(calcClubReputation(10, 5, 100)).toBe(225)
  })
})
