import { describe, it, expect, beforeEach } from "vitest";
import { registerJob, runJob, listJobs, instrument } from "../app/src/lib/jobRegistry";

beforeEach(() => {
  // Each test registers fresh names; listJobs accumulates but registerJob
  // overwrites by name, so call with unique names per test.
});

describe("jobRegistry", () => {
  it("registerJob then listJobs returns the record", () => {
    registerJob({ name: "j1", description: "d", intervalMs: 1000, handler: () => undefined });
    const recs = listJobs();
    const r = recs.find(x => x.name === "j1");
    expect(r).toBeDefined();
    expect(r?.lastStatus).toBe("idle");
    expect(r?.runCount).toBe(0);
  });

  it("runJob updates status to ok on success and increments runCount", async () => {
    registerJob({ name: "j2", description: "", intervalMs: 1000, handler: () => undefined });
    await runJob("j2");
    const r = listJobs().find(x => x.name === "j2");
    expect(r?.lastStatus).toBe("ok");
    expect(r?.runCount).toBe(1);
    expect(r?.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("runJob captures error and marks lastStatus=error", async () => {
    registerJob({ name: "j3", description: "", intervalMs: 1000, handler: () => { throw new Error("boom") } });
    await expect(runJob("j3")).rejects.toThrow("boom");
    const r = listJobs().find(x => x.name === "j3");
    expect(r?.lastStatus).toBe("error");
    expect(r?.lastError).toBe("boom");
  });

  it("instrument wrapper updates the registry without throwing", async () => {
    registerJob({ name: "j4", description: "", intervalMs: 1000, handler: () => undefined });
    const wrapped = instrument("j4", () => { throw new Error("nope") });
    await wrapped();   // swallows error
    const r = listJobs().find(x => x.name === "j4");
    expect(r?.lastStatus).toBe("error");
    expect(r?.runCount).toBe(1);
  });

  it("runJob on unknown name throws", async () => {
    await expect(runJob("does-not-exist")).rejects.toThrow(/unknown job/);
  });
});
