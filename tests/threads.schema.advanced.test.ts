/**
 * Advanced threads schema tests.
 */
import { describe, it, expect } from "vitest";
import { createThreadSchema, updateThreadSchema, createReplySchema } from "../app/src/modules/threads/threads.schema";

describe("createThreadSchema — boundary values", () => {
  const validContent = "This is a valid thread content that meets the minimum length requirement.";

  it("accepts title with exactly 3 chars (min)", () => {
    expect(() => createThreadSchema.parse({ title: "abc", content: validContent })).not.toThrow();
  });

  it("rejects title under 3 chars", () => {
    expect(() => createThreadSchema.parse({ title: "ab", content: validContent })).toThrow();
  });

  it("accepts title with exactly 120 chars (max)", () => {
    expect(() => createThreadSchema.parse({ title: "a".repeat(120), content: validContent })).not.toThrow();
  });

  it("rejects title over 120 chars", () => {
    expect(() => createThreadSchema.parse({ title: "a".repeat(121), content: validContent })).toThrow();
  });

  it("accepts content with exactly 10 chars (min)", () => {
    expect(() => createThreadSchema.parse({ title: "Thread Title", content: "1234567890" })).not.toThrow();
  });

  it("rejects content under 10 chars", () => {
    expect(() => createThreadSchema.parse({ title: "Thread Title", content: "123456789" })).toThrow();
  });

  it("accepts content with exactly 20000 chars (max)", () => {
    expect(() => createThreadSchema.parse({ title: "Thread Title", content: "a".repeat(20000) })).not.toThrow();
  });

  it("rejects content over 20000 chars", () => {
    expect(() => createThreadSchema.parse({ title: "Thread Title", content: "a".repeat(20001) })).toThrow();
  });

  it("accepts thread with special chars in title", () => {
    expect(() => createThreadSchema.parse({
      title: "Attack on Titan: Episode Discussion!",
      content: validContent,
    })).not.toThrow();
  });
});

describe("updateThreadSchema — partial updates", () => {
  it("accepts empty object (all optional)", () => {
    expect(() => updateThreadSchema.parse({})).not.toThrow();
  });

  it("accepts partial title update only", () => {
    expect(() => updateThreadSchema.parse({ title: "New Title Here" })).not.toThrow();
  });

  it("accepts partial content update only", () => {
    expect(() => updateThreadSchema.parse({ content: "Updated content that is long enough." })).not.toThrow();
  });

  it("still validates min length on partial update", () => {
    expect(() => updateThreadSchema.parse({ title: "ab" })).toThrow(); // too short
    expect(() => updateThreadSchema.parse({ content: "short" })).toThrow(); // too short
  });
});

describe("createReplySchema — boundary values", () => {
  it("accepts reply with exactly 1 char", () => {
    expect(() => createReplySchema.parse({ content: "a" })).not.toThrow();
  });

  it("rejects empty reply", () => {
    expect(() => createReplySchema.parse({ content: "" })).toThrow();
  });

  it("accepts reply with exactly 10000 chars", () => {
    expect(() => createReplySchema.parse({ content: "a".repeat(10000) })).not.toThrow();
  });

  it("rejects reply over 10000 chars", () => {
    expect(() => createReplySchema.parse({ content: "a".repeat(10001) })).toThrow();
  });

  it("accepts reply without parentId", () => {
    expect(() => createReplySchema.parse({ content: "My reply" })).not.toThrow();
    expect(createReplySchema.parse({ content: "My reply" }).parentId).toBeUndefined();
  });

  it("rejects parentId that is not a CUID", () => {
    // CUID starts with 'c' and is alphanumeric; UUID has dashes
    expect(() => createReplySchema.parse({ content: "Reply", parentId: "not-a-cuid!!!" })).toThrow();
  });
});
