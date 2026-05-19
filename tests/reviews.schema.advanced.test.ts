/**
 * Advanced reviews schema tests.
 */
import { describe, it, expect } from "vitest";
import { createReviewSchema, updateReviewSchema } from "../app/src/modules/reviews/reviews.schema";

describe("createReviewSchema — content validation", () => {
  const valid = { animeId: "anime-1", score: 8, body: "This is a very detailed review of the anime that meets min length.", hasSpoilers: false };

  it("accepts review without hasSpoilers (optional)", () => {
    const { hasSpoilers, ...rest } = valid;
    expect(() => createReviewSchema.parse(rest)).not.toThrow();
  });

  it("hasSpoilers defaults to undefined when not provided", () => {
    const result = createReviewSchema.parse({ animeId: "a1", score: 8, body: "a".repeat(20) });
    expect(result.hasSpoilers).toBeUndefined();
  });

  it("accepts hasSpoilers: true", () => {
    expect(() => createReviewSchema.parse({ ...valid, hasSpoilers: true })).not.toThrow();
  });

  it("accepts hasSpoilers: false", () => {
    expect(() => createReviewSchema.parse({ ...valid, hasSpoilers: false })).not.toThrow();
  });

  it("rejects score as float", () => {
    expect(() => createReviewSchema.parse({ ...valid, score: 8.5 })).toThrow();
  });

  it("rejects score as string", () => {
    expect(() => createReviewSchema.parse({ ...valid, score: "8" })).toThrow();
  });

  it("rejects empty animeId", () => {
    expect(() => createReviewSchema.parse({ ...valid, animeId: "" })).toThrow();
  });

  it("accepts score of 1 through 10 (all integers)", () => {
    for (let score = 1; score <= 10; score++) {
      expect(() => createReviewSchema.parse({ ...valid, score })).not.toThrow();
    }
  });
});

describe("updateReviewSchema — partial updates", () => {
  it("accepts only score update", () => {
    expect(() => updateReviewSchema.parse({ score: 9 })).not.toThrow();
  });

  it("accepts only body update", () => {
    expect(() => updateReviewSchema.parse({ body: "Updated review that meets the minimum 20 character length." })).not.toThrow();
  });

  it("accepts only hasSpoilers toggle", () => {
    expect(() => updateReviewSchema.parse({ hasSpoilers: true })).not.toThrow();
  });

  it("accepts all fields at once", () => {
    expect(() => updateReviewSchema.parse({
      score: 7,
      body: "Updated review content that is long enough.",
      hasSpoilers: false,
    })).not.toThrow();
  });

  it("still validates score range in partial update", () => {
    expect(() => updateReviewSchema.parse({ score: 0 })).toThrow();
    expect(() => updateReviewSchema.parse({ score: 11 })).toThrow();
  });

  it("still validates body min length in partial update", () => {
    expect(() => updateReviewSchema.parse({ body: "Short" })).toThrow();
  });
});
