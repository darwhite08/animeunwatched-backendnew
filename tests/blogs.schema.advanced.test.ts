/**
 * Advanced blogs schema tests.
 */
import { describe, it, expect } from "vitest";
import { createBlogSchema, updateBlogSchema } from "../app/src/modules/blogs/blogs.schema";

describe("createBlogSchema — comprehensive validation", () => {
  const valid = { title: "My Blog Post Title", body: "Content of the blog post." };

  it("accepts DRAFT status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "DRAFT" })).not.toThrow();
  });

  it("accepts PUBLISHED status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "PUBLISHED" })).not.toThrow();
  });

  it("rejects ARCHIVED status", () => {
    expect(() => createBlogSchema.parse({ ...valid, status: "ARCHIVED" })).toThrow();
  });

  it("accepts body with markdown content", () => {
    const markdownBody = "# Heading\n\n## Subheading\n\n**Bold** and *italic*\n\n- List item\n- Another item";
    expect(() => createBlogSchema.parse({ ...valid, body: markdownBody })).not.toThrow();
  });

  it("accepts body with code blocks", () => {
    const codeBody = "Here is some code:\n\n```javascript\nconst x = 1;\n```\n\nEnd of content.";
    expect(() => createBlogSchema.parse({ ...valid, body: codeBody })).not.toThrow();
  });

  it("accepts title with numbers and special chars", () => {
    expect(() => createBlogSchema.parse({ ...valid, title: "Top 10 Anime of 2024: A Deep Dive!" })).not.toThrow();
  });

  it("rejects body as non-string", () => {
    expect(() => createBlogSchema.parse({ ...valid, body: 123 })).toThrow();
    expect(() => createBlogSchema.parse({ ...valid, body: null })).toThrow();
    expect(() => createBlogSchema.parse({ ...valid, body: [] })).toThrow();
  });
});

describe("updateBlogSchema — comprehensive validation", () => {
  it("accepts all three fields updated together", () => {
    expect(() => updateBlogSchema.parse({
      title: "Updated Title",
      body: "Updated body content that meets the minimum length.",
      status: "PUBLISHED",
    })).not.toThrow();
  });

  it("accepts status as only field", () => {
    expect(() => updateBlogSchema.parse({ status: "DRAFT" })).not.toThrow();
  });

  it("accepts undefined for optional fields", () => {
    const result = updateBlogSchema.parse({ status: "PUBLISHED" });
    expect(result.title).toBeUndefined();
    expect(result.body).toBeUndefined();
    expect(result.status).toBe("PUBLISHED");
  });

  it("still enforces title min length on update", () => {
    expect(() => updateBlogSchema.parse({ title: "" })).toThrow();
    expect(() => updateBlogSchema.parse({ title: "a" })).not.toThrow();
  });
});
