/**
 * Reviews schema boundary tests.
 */
import { describe, it, expect } from "vitest";

async function getSchema() {
  return import("../app/src/modules/reviews/reviews.schema");
}

describe("createReviewSchema — boundary tests", () => {
  const valid = { animeId: "anime-id-1", score: 8, body: "This is a great anime that everyone should watch!", hasSpoilers: false };

  it("accepts valid data", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse(valid)).not.toThrow();
  });

  it("fails with score below 1", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, score: 0 })).toThrow();
  });

  it("fails with score above 10", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, score: 11 })).toThrow();
  });

  it("accepts score of exactly 1 and 10", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, score: 1 })).not.toThrow();
    expect(() => createReviewSchema.parse({ ...valid, score: 10 })).not.toThrow();
  });

  it("fails with body under 20 chars", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, body: "Too short" })).toThrow();
  });

  it("accepts body with exactly 20 chars", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, body: "a".repeat(20) })).not.toThrow();
  });

  it("fails with body over 10000 chars", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, body: "a".repeat(10001) })).toThrow();
  });

  it("accepts body with exactly 10000 chars", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, body: "a".repeat(10000) })).not.toThrow();
  });

  it("hasSpoilers defaults to undefined when not provided", async () => {
    const { createReviewSchema } = await getSchema();
    const result = createReviewSchema.parse({ animeId: "a", score: 8, body: "a".repeat(20) });
    expect(result.hasSpoilers).toBeUndefined();
  });

  it("fails with non-integer score", async () => {
    const { createReviewSchema } = await getSchema();
    expect(() => createReviewSchema.parse({ ...valid, score: 8.5 })).toThrow();
  });
});

describe("updateReviewSchema — partial updates", () => {
  it("accepts empty object (all fields optional)", async () => {
    const { updateReviewSchema } = await getSchema();
    expect(() => updateReviewSchema.parse({})).not.toThrow();
  });

  it("accepts partial update with just score", async () => {
    const { updateReviewSchema } = await getSchema();
    expect(() => updateReviewSchema.parse({ score: 9 })).not.toThrow();
  });

  it("accepts partial update with just body", async () => {
    const { updateReviewSchema } = await getSchema();
    expect(() => updateReviewSchema.parse({ body: "Updated review body that is at least 20 chars long" })).not.toThrow();
  });
});
