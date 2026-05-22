/**
 * AI module schema validation tests.
 */
import { describe, it, expect } from "vitest";
import { askSchema } from "../app/src/modules/ai/ai.schema";

describe("askSchema", () => {
  it("accepts a non-empty prompt", () => {
    expect(() => askSchema.parse({ prompt: "Compare Naruto and Bleach" })).not.toThrow();
  });

  it("rejects empty prompt", () => {
    expect(() => askSchema.parse({ prompt: "" })).toThrow();
  });

  it("rejects prompt over 2000 chars", () => {
    expect(() => askSchema.parse({ prompt: "a".repeat(2001) })).toThrow();
  });

  it("accepts prompt with exactly 2000 chars", () => {
    expect(() => askSchema.parse({ prompt: "a".repeat(2000) })).not.toThrow();
  });

  it("accepts optional context with animeId + conversationId", () => {
    expect(() =>
      askSchema.parse({
        prompt: "Tell me more",
        context: { animeId: "anime-1", conversationId: "conv-1" },
      }),
    ).not.toThrow();
  });

  it("rejects missing prompt", () => {
    expect(() => askSchema.parse({})).toThrow();
  });
});
