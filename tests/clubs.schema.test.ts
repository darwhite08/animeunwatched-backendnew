/**
 * Clubs and threads schema validation tests.
 */
import { describe, it, expect } from "vitest";

// Import schemas
async function getClubsSchema() {
  const mod = await import("../app/src/modules/clubs/clubs.schema");
  return mod;
}

async function getThreadsSchema() {
  const mod = await import("../app/src/modules/threads/threads.schema");
  return mod;
}

describe("createClubSchema", () => {
  it("passes with valid data", async () => {
    const { createClubSchema } = await getClubsSchema();
    expect(() => createClubSchema.parse({ name: "My Club", slug: "my-club", description: "desc" })).not.toThrow();
  });

  it("fails without name", async () => {
    const { createClubSchema } = await getClubsSchema();
    expect(() => createClubSchema.parse({ slug: "my-club" })).toThrow();
  });

  it("fails without slug", async () => {
    const { createClubSchema } = await getClubsSchema();
    expect(() => createClubSchema.parse({ name: "My Club" })).toThrow();
  });
});

describe("createThreadSchema", () => {
  it("passes with valid data", async () => {
    const { createThreadSchema } = await getThreadsSchema();
    expect(() => createThreadSchema.parse({ title: "My Thread Title", content: "This is thread content that meets the 10 char min." })).not.toThrow();
  });

  it("fails with content under 10 chars", async () => {
    const { createThreadSchema } = await getThreadsSchema();
    expect(() => createThreadSchema.parse({ title: "Title", content: "Short" })).toThrow();
  });

  it("fails with title under 3 chars", async () => {
    const { createThreadSchema } = await getThreadsSchema();
    expect(() => createThreadSchema.parse({ title: "ab", content: "This is long enough content for the test." })).toThrow();
  });

  it("fails with content over 20000 chars", async () => {
    const { createThreadSchema } = await getThreadsSchema();
    const longContent = "a".repeat(20001);
    expect(() => createThreadSchema.parse({ title: "Valid Title", content: longContent })).toThrow();
  });
});

describe("createReplySchema", () => {
  it("passes with valid content", async () => {
    const { createReplySchema } = await getThreadsSchema();
    expect(() => createReplySchema.parse({ content: "This is a reply" })).not.toThrow();
  });

  it("fails with empty content", async () => {
    const { createReplySchema } = await getThreadsSchema();
    expect(() => createReplySchema.parse({ content: "" })).toThrow();
  });

  it("fails with content over 10000 chars", async () => {
    const { createReplySchema } = await getThreadsSchema();
    expect(() => createReplySchema.parse({ content: "x".repeat(10001) })).toThrow();
  });

  it("allows optional parentId as cuid", async () => {
    const { createReplySchema } = await getThreadsSchema();
    expect(() => createReplySchema.parse({ content: "Reply", parentId: "clxxxxxxxxxxxxxxxxxxxxxxxxx" })).not.toThrow();
  });

  it("fails with non-cuid parentId", async () => {
    const { createReplySchema } = await getThreadsSchema();
    expect(() => createReplySchema.parse({ content: "Reply", parentId: "not-a-cuid!!!" })).toThrow();
  });
});
