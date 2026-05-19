/**
 * Posts schema validation tests.
 */
import { describe, it, expect } from "vitest";
import { createPostSchema, createCommentSchema } from "../app/src/modules/posts/posts.schema";

describe("createPostSchema", () => {
  it("accepts valid content", () => {
    expect(() => createPostSchema.parse({ content: "This is a post!" })).not.toThrow();
  });

  it("rejects empty content", () => {
    expect(() => createPostSchema.parse({ content: "" })).toThrow();
  });

  it("rejects content over 5000 chars", () => {
    expect(() => createPostSchema.parse({ content: "a".repeat(5001) })).toThrow();
  });

  it("accepts content with exactly 5000 chars", () => {
    expect(() => createPostSchema.parse({ content: "a".repeat(5000) })).not.toThrow();
  });

  it("accepts optional animeId", () => {
    expect(() => createPostSchema.parse({ content: "Post!", animeId: "anime-123" })).not.toThrow();
  });

  it("passes without animeId", () => {
    expect(() => createPostSchema.parse({ content: "Post without anime!" })).not.toThrow();
  });
});

describe("createCommentSchema", () => {
  it("accepts valid content", () => {
    expect(() => createCommentSchema.parse({ content: "Great comment!" })).not.toThrow();
  });

  it("rejects empty content", () => {
    expect(() => createCommentSchema.parse({ content: "" })).toThrow();
  });

  it("rejects content over 2000 chars", () => {
    expect(() => createCommentSchema.parse({ content: "a".repeat(2001) })).toThrow();
  });

  it("accepts content with exactly 2000 chars", () => {
    expect(() => createCommentSchema.parse({ content: "a".repeat(2000) })).not.toThrow();
  });

  it("accepts content with exactly 1 char", () => {
    expect(() => createCommentSchema.parse({ content: "a" })).not.toThrow();
  });
});
