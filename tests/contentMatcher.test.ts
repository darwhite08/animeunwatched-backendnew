import { describe, it, expect, vi, beforeEach } from "vitest"

const rules: Array<{ id: string; name: string; kind: string; pattern: string; severity: string; enabled: boolean; target: string }> = []
const updates: Array<{ id: string; increment: number }> = []

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    contentRule: {
      findMany: vi.fn(async ({ where }: { where: { enabled: boolean; target: string } }) =>
        rules.filter(r => r.enabled === where.enabled && r.target === where.target)),
      update:   vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: { matchCount: { increment: number } } }) => {
        updates.push({ id, increment: data.matchCount.increment })
        return undefined
      }),
    },
    contentFingerprint: {
      upsert: vi.fn(async () => undefined),
    },
  },
}))

import { matchContent, invalidateContentRuleCache, contentHash, recordFingerprint } from "../app/src/lib/contentMatcher"

beforeEach(() => {
  rules.length = 0
  updates.length = 0
  invalidateContentRuleCache()
})

describe("contentMatcher", () => {
  it("returns null when no rules exist", async () => {
    const m = await matchContent({ content: "hello world", target: "post" })
    expect(m).toBeNull()
  })

  it("keyword match is case-insensitive + supports comma list", async () => {
    rules.push({ id: "r1", name: "Slurs", kind: "keyword", pattern: "badword,worse_word", severity: "block", enabled: true, target: "post" })
    const m = await matchContent({ content: "this is a BADWORD post", target: "post" })
    expect(m?.severity).toBe("block")
    expect(m?.detail).toContain("badword")
  })

  it("regex match", async () => {
    rules.push({ id: "r2", name: "Phone", kind: "regex", pattern: "\\b\\d{3}-\\d{4}\\b", severity: "flag", enabled: true, target: "post" })
    const m = await matchContent({ content: "call 555-1234 now", target: "post" })
    expect(m?.detail).toContain("regex")
  })

  it("regex with invalid pattern is silently skipped", async () => {
    rules.push({ id: "r3", name: "Bad regex", kind: "regex", pattern: "[invalid(", severity: "block", enabled: true, target: "post" })
    rules.push({ id: "r4", name: "Good keyword", kind: "keyword", pattern: "hi", severity: "flag", enabled: true, target: "post" })
    const m = await matchContent({ content: "hi there", target: "post" })
    expect(m?.ruleId).toBe("r4")  // good rule still matches
  })

  it("min_length flags posts shorter than threshold", async () => {
    rules.push({ id: "r5", name: "Short", kind: "min_length", pattern: "10", severity: "flag", enabled: true, target: "post" })
    const m = await matchContent({ content: "hi", target: "post" })
    expect(m?.detail).toContain("length 2")
  })

  it("link_count flags posts with too many URLs", async () => {
    rules.push({ id: "r6", name: "Spam links", kind: "link_count", pattern: "1", severity: "block", enabled: true, target: "post" })
    const m = await matchContent({ content: "check https://a.com and https://b.com", target: "post" })
    expect(m?.detail).toContain("2 links")
  })

  it("block beats shadow beats flag (severity rank)", async () => {
    rules.push({ id: "f", name: "Flag",   kind: "keyword", pattern: "x", severity: "flag",   enabled: true, target: "post" })
    rules.push({ id: "s", name: "Shadow", kind: "keyword", pattern: "x", severity: "shadow", enabled: true, target: "post" })
    rules.push({ id: "b", name: "Block",  kind: "keyword", pattern: "x", severity: "block",  enabled: true, target: "post" })
    const m = await matchContent({ content: "x", target: "post" })
    expect(m?.severity).toBe("block")
    expect(m?.ruleId).toBe("b")
  })

  it("disabled rules are ignored", async () => {
    rules.push({ id: "off", name: "Off", kind: "keyword", pattern: "hi", severity: "block", enabled: false, target: "post" })
    const m = await matchContent({ content: "hi", target: "post" })
    expect(m).toBeNull()
  })

  it("target filter — comment rules don't fire on posts", async () => {
    rules.push({ id: "c", name: "Comment-only", kind: "keyword", pattern: "hi", severity: "block", enabled: true, target: "comment" })
    const m = await matchContent({ content: "hi", target: "post" })
    expect(m).toBeNull()
  })

  it("increments matchCount on hit", async () => {
    rules.push({ id: "k", name: "K", kind: "keyword", pattern: "hi", severity: "flag", enabled: true, target: "post" })
    await matchContent({ content: "hi", target: "post" })
    // Wait a microtask for the fire-and-forget update
    await new Promise(r => setTimeout(r, 5))
    expect(updates).toContainEqual({ id: "k", increment: 1 })
  })

  it("contentHash normalizes whitespace + lowercase", () => {
    expect(contentHash("Hello   World")).toBe(contentHash("hello world"))
    expect(contentHash("hello world").length).toBe(64)
  })

  it("recordFingerprint upserts the row", async () => {
    await expect(recordFingerprint({
      content: "x", targetType: "Post", targetId: "p1", decision: "removed", matchedRule: "r1",
    })).resolves.toBeUndefined()
  })
})
