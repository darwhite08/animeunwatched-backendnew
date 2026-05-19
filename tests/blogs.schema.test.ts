/**
 * Blog schema validation tests.
 */
import { describe, it, expect } from "vitest";
import { createBlogSchema, updateBlogSchema } from "../app/src/modules/blogs/blogs.schema";

describe("createBlogSchema", () => {
  const valid = { title: "My Amazing Blog Post", body: "This is the blog content.", status: "DRAFT" as const };

  it("passes with valid data", () => {
    expect(() => createBlogSchema.parse(valid)).not.toThrow();
  });

  it("passes without status (optional)", () => {
    expect(() => createBlogSchema.parse({ title: "Title", body: "Body content" })).not.toThrow();
  });

  it("rejects empty title", () => {
    expect(() => createBlogSchema.parse({ ...valid, title: "" })).toThrow();
  });

  it("rejects title over 200 chars", () => {
    expect(() => createBlogSchema.parse({ ...valid, title: "a".repeat(201) })).toThrow();
  });

  it("accepts title with exactly 200 chars", () => {
    expect(() => createBlogSchema.parse({ ...valid, title: "a".repeat(200) })).not.toThrow();
  });

  it("rejects empty body", () => {
    expect(() => createBlogSchema.parse({ ...valid, body: "" })).toThrow();
  });

  it("rejects body over 200,000 chars", () => {
    expect(() => createBlogSchema.parse({ ...valid, body: "a".repeat(200_001) })).toThrow();
  });

  it("accepts body with exactly 200,000 chars", () => {
    expect(() => createBlogSchema.parse({ ...valid, body: "a".repeat(200_000) })).not.toThrow();
  });

  it("accepts DRAFT status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "DRAFT" })).not.toThrow();
  });

  it("accepts PUBLISHED status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "PUBLISHED" })).not.toThrow();
  });

  it("rejects invalid status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "PENDING" })).toThrow();
  });
});

describe("updateBlogSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(() => updateBlogSchema.parse({})).not.toThrow();
  });

  it("accepts partial title update", () => {
    expect(() => updateBlogSchema.parse({ title: "New Title" })).not.toThrow();
  });

  it("accepts status change to PUBLISHED", () => {
    expect(() => updateBlogSchema.parse({ status: "PUBLISHED" })).not.toThrow();
  });

  it("rejects invalid status value", () => {
    expect(() => updateBlogSchema.parse({ status: "DELETED" })).toThrow();
  });

  it("rejects empty title (even in update)", () => {
    expect(() => updateBlogSchema.parse({ title: "" })).toThrow();
  });
});
