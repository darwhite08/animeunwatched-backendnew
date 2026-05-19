/**
 * Lists schema validation tests.
 */
import { describe, it, expect } from "vitest";

async function getSchema() {
  return import("../app/src/modules/lists/lists.schema");
}

describe("upsertEntrySchema", () => {
  it("accepts valid WATCHING status", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING" })).not.toThrow();
  });

  it("accepts all valid WatchStatus values", async () => {
    const { upsertEntrySchema } = await getSchema();
    const validStatuses = ["PLAN_TO_WATCH", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED"];
    for (const status of validStatuses) {
      expect(() => upsertEntrySchema.parse({ status })).not.toThrow();
    }
  });

  it("rejects invalid status", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING_CAREFULLY" })).toThrow();
  });

  it("accepts optional score", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "COMPLETED", score: 9 })).not.toThrow();
  });

  it("rejects score below 1", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "COMPLETED", score: 0 })).toThrow();
  });

  it("rejects score above 10", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "COMPLETED", score: 11 })).toThrow();
  });

  it("accepts score of exactly 1 and 10", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", score: 1 })).not.toThrow();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", score: 10 })).not.toThrow();
  });

  it("accepts optional episodesSeen", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", episodesSeen: 5 })).not.toThrow();
  });

  it("rejects negative episodesSeen", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", episodesSeen: -1 })).toThrow();
  });

  it("accepts optional notes string", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", notes: "My notes" })).not.toThrow();
  });

  it("accepts optional startedAt date string", async () => {
    const { upsertEntrySchema } = await getSchema();
    expect(() => upsertEntrySchema.parse({ status: "WATCHING", startedAt: "2024-01-01T00:00:00Z" })).not.toThrow();
  });
});
