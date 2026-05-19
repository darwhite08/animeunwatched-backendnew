/**
 * Advanced clubs schema tests.
 */
import { describe, it, expect } from "vitest";
import { createClubSchema } from "../app/src/modules/clubs/clubs.schema";

describe("createClubSchema — slug validation", () => {
  const base = { name: "My Club", slug: "my-club" };

  it("accepts lowercase alphanumeric slug", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "my-club-123" })).not.toThrow();
  });

  it("rejects uppercase in slug", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "My-Club" })).toThrow();
  });

  it("rejects underscores in slug", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "my_club" })).toThrow();
  });

  it("rejects spaces in slug", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "my club" })).toThrow();
  });

  it("rejects too short slug (under 3 chars)", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "ab" })).toThrow();
  });

  it("accepts slug with exactly 3 chars", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "abc" })).not.toThrow();
  });

  it("rejects slug over 30 chars", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "a".repeat(31) })).toThrow();
  });

  it("accepts slug with exactly 30 chars", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "a".repeat(30) })).not.toThrow();
  });

  it("accepts slug with hyphens between words", () => {
    expect(() => createClubSchema.parse({ ...base, slug: "naruto-fans-2024" })).not.toThrow();
  });

  it("allows slug with hyphen (any position)", () => {
    // The slug regex allows hyphens anywhere: /^[a-z0-9-]+$/
    expect(() => createClubSchema.parse({ ...base, slug: "my-club-here" })).not.toThrow();
  });
});

describe("createClubSchema — name validation", () => {
  const base = { name: "My Club", slug: "my-club" };

  it("rejects name under 3 chars", () => {
    expect(() => createClubSchema.parse({ ...base, name: "ab" })).toThrow();
  });

  it("accepts name with exactly 3 chars", () => {
    expect(() => createClubSchema.parse({ ...base, name: "abc" })).not.toThrow();
  });

  it("rejects name over 60 chars", () => {
    expect(() => createClubSchema.parse({ ...base, name: "a".repeat(61) })).toThrow();
  });

  it("accepts name with exactly 60 chars", () => {
    expect(() => createClubSchema.parse({ ...base, name: "a".repeat(60) })).not.toThrow();
  });

  it("accepts name with spaces (unlike slug)", () => {
    expect(() => createClubSchema.parse({ ...base, name: "Naruto Fans Club" })).not.toThrow();
  });
});

describe("createClubSchema — description validation", () => {
  const base = { name: "My Club", slug: "my-club" };

  it("accepts optional description", () => {
    expect(() => createClubSchema.parse({ ...base, description: "A great club" })).not.toThrow();
    expect(() => createClubSchema.parse({ ...base })).not.toThrow(); // no description
  });

  it("rejects description over 1000 chars", () => {
    expect(() => createClubSchema.parse({ ...base, description: "a".repeat(1001) })).toThrow();
  });

  it("accepts description with exactly 1000 chars", () => {
    expect(() => createClubSchema.parse({ ...base, description: "a".repeat(1000) })).not.toThrow();
  });
});
