/**
 * Users schema validation tests.
 */
import { describe, it, expect } from "vitest";
import { updateMeSchema } from "../app/src/modules/users/users.schema";

describe("updateMeSchema", () => {
  it("accepts valid displayName", () => {
    expect(() => updateMeSchema.parse({ displayName: "Naruto Uzumaki" })).not.toThrow();
  });

  it("accepts valid bio", () => {
    expect(() => updateMeSchema.parse({ bio: "Believe it!" })).not.toThrow();
  });

  it("accepts valid avatarUrl", () => {
    expect(() => updateMeSchema.parse({ avatarUrl: "https://example.com/avatar.jpg" })).not.toThrow();
  });

  it("accepts empty object (all optional)", () => {
    expect(() => updateMeSchema.parse({})).not.toThrow();
  });

  it("rejects empty displayName", () => {
    expect(() => updateMeSchema.parse({ displayName: "" })).toThrow();
  });

  it("rejects displayName over 60 chars", () => {
    expect(() => updateMeSchema.parse({ displayName: "a".repeat(61) })).toThrow();
  });

  it("accepts displayName with exactly 60 chars", () => {
    expect(() => updateMeSchema.parse({ displayName: "a".repeat(60) })).not.toThrow();
  });

  it("rejects bio over 500 chars", () => {
    expect(() => updateMeSchema.parse({ bio: "a".repeat(501) })).toThrow();
  });

  it("accepts bio with exactly 500 chars", () => {
    expect(() => updateMeSchema.parse({ bio: "a".repeat(500) })).not.toThrow();
  });

  it("rejects invalid avatarUrl (not a URL)", () => {
    expect(() => updateMeSchema.parse({ avatarUrl: "not-a-url" })).toThrow();
  });

  it("rejects avatarUrl that is not a URL at all", () => {
    expect(() => updateMeSchema.parse({ avatarUrl: "this is not a url at all" })).toThrow();
  });

  it("accepts partial update with multiple fields", () => {
    expect(() => updateMeSchema.parse({
      displayName: "New Name",
      bio: "New bio",
    })).not.toThrow();
  });
});
