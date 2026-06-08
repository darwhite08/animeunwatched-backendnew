/**
 * Monetization money math — the 90/10 split and eligibility gate
 * (docs/monetization-system.md). Money is integer cents; creators keep 90%.
 */
import { describe, it, expect } from "vitest";
import {
  PLATFORM_FEE_BPS,
  computeSplit,
  evaluateEligibility,
  platformMargin,
} from "../app/src/lib/monetizationMath";

describe("computeSplit — 90/10, creator keeps 90%", () => {
  it("nets the creator exactly 90% of gross", () => {
    const s = computeSplit(1000); // $10
    expect(s.platformFeeCents).toBe(100); // 10%
    expect(s.netCents).toBe(900); // creator keeps 90%
    expect(PLATFORM_FEE_BPS).toBe(1000);
  });

  it("processor fee is tracked but platform-borne (not deducted from creator)", () => {
    const s = computeSplit(1000);
    // creator net is unaffected by the processor fee
    expect(s.netCents).toBe(900);
    // processor estimate = 2.9% + 30¢ = 59¢ on $10
    expect(s.processorFeeCents).toBe(59);
    // platform keeps its 10% minus the processor cost
    expect(platformMargin(s)).toBe(100 - 59);
  });

  it("rounds correctly and never goes negative", () => {
    expect(computeSplit(0)).toEqual({ grossCents: 0, platformFeeCents: 0, processorFeeCents: 0, netCents: 0 });
    const s = computeSplit(333);
    expect(s.platformFeeCents).toBe(33);
    expect(s.netCents).toBe(300);
    expect(computeSplit(-50).grossCents).toBe(0);
  });

  it("conserves money: net + platformFee = gross", () => {
    for (const g of [199, 500, 1234, 99999]) {
      const s = computeSplit(g);
      expect(s.netCents + s.platformFeeCents).toBe(s.grossCents);
    }
  });
});

describe("evaluateEligibility — YPP-style gate", () => {
  const ok = { followers: 150, reputation: 250, accountAgeDays: 60, inGoodStanding: true };

  it("passes when all requirements met", () => {
    expect(evaluateEligibility(ok)).toEqual({ isEligible: true, reasons: [] });
  });
  it("lists every unmet requirement", () => {
    const r = evaluateEligibility({ followers: 10, reputation: 50, accountAgeDays: 5, inGoodStanding: false });
    expect(r.isEligible).toBe(false);
    expect(r.reasons).toHaveLength(4);
  });
  it("banned account is ineligible even with metrics", () => {
    expect(evaluateEligibility({ ...ok, inGoodStanding: false }).isEligible).toBe(false);
  });
});
