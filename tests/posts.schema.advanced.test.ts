/**
 * Advanced posts schema tests.
 */
import { describe, it, expect } from "vitest";
import { createPostSchema, createCommentSchema } from "../app/src/modules/posts/posts.schema";

describe("createPostSchema — boundary values", () => {
  it("accepts content with exactly 1 char", () => {
    expect(() => createPostSchema.parse({ content: "a" })).not.toThrow();
  });

  it("accepts content with exactly 5000 chars", () => {
    expect(() => createPostSchema.parse({ content: "a".repeat(5000) })).not.toThrow();
  });

  it("rejects content with 5001 chars", () => {
    expect(() => createPostSchema.parse({ content: "a".repeat(5001) })).toThrow();
  });

  it("accepts post with emoji content", () => {
    expect(() => createPostSchema.parse({ content: "🔥 One Piece is amazing! 🏴‍☠️" })).not.toThrow();
  });

  it("accepts post with newlines", () => {
    expect(() => createPostSchema.parse({ content: "Line 1\nLine 2\nLine 3" })).not.toThrow();
  });

  it("accepts optional animeId as undefined", () => {
    const result = createPostSchema.parse({ content: "Test post!" });
    expect(result.animeId).toBeUndefined();
  });

  it("accepts optional animeId as non-empty string", () => {
    const result = createPostSchema.parse({ content: "Test!", animeId: "anime-123" });
    expect(result.animeId).toBe("anime-123");
  });
});

describe("createCommentSchema — content types", () => {
  it("accepts single character", () => {
    expect(() => createCommentSchema.parse({ content: "!" })).not.toThrow();
  });

  it("accepts multi-line comment", () => {
    expect(() => createCommentSchema.parse({
      content: "First line\nSecond line\nThird line"
    })).not.toThrow();
  });

  it("accepts comment with special characters", () => {
    expect(() => createCommentSchema.parse({
      content: "Great post! <3 @user #anime"
    })).not.toThrow();
  });

  it("rejects object body instead of string", () => {
    expect(() => createCommentSchema.parse({ content: {} })).toThrow();
  });

  it("rejects null content", () => {
    expect(() => createCommentSchema.parse({ content: null })).toThrow();
  });
});
