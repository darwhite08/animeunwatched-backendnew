/**
 * Polls schema validation tests.
 */
import { describe, it, expect } from "vitest";

async function getSchema() {
  return import("../app/src/modules/polls/polls.schema");
}

describe("createPollSchema", () => {
  it("passes with valid data", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "Which anime is the best?",
      options:  ["Attack on Titan", "One Piece", "Naruto"],
    })).not.toThrow();
  });

  it("fails with question under 5 chars", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "why?",
      options:  ["Yes", "No"],
    })).toThrow();
  });

  it("fails with only 1 option", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "Best anime?",
      options:  ["One Piece"],
    })).toThrow();
  });

  it("fails with more than 6 options", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "Best anime?",
      options:  ["A", "B", "C", "D", "E", "F", "G"],
    })).toThrow();
  });

  it("fails with question over 200 chars", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "a".repeat(201),
      options:  ["Yes", "No"],
    })).toThrow();
  });

  it("accepts optional expiresInDays", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question:      "Best anime?",
      options:       ["A", "B"],
      expiresInDays: 3,
    })).not.toThrow();
  });

  it("accepts optional expiresIn hours", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question:  "Best anime?",
      options:   ["A", "B"],
      expiresIn: 24,
    })).not.toThrow();
  });

  it("passes without either expiry field (uses default 7 days in service)", async () => {
    const { createPollSchema } = await getSchema();
    expect(() => createPollSchema.parse({
      question: "Best anime?",
      options:  ["A", "B"],
    })).not.toThrow();
  });
});

describe("voteSchema", () => {
  it("passes with valid optionId", async () => {
    const { voteSchema } = await getSchema();
    expect(() => voteSchema.parse({ optionId: "opt-123" })).not.toThrow();
  });

  it("fails with empty optionId", async () => {
    const { voteSchema } = await getSchema();
    expect(() => voteSchema.parse({ optionId: "" })).toThrow();
  });

  it("fails without optionId", async () => {
    const { voteSchema } = await getSchema();
    expect(() => voteSchema.parse({})).toThrow();
  });
});
