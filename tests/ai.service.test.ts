/**
 * AI service tests — verify stub fallback when OPENAI_API_KEY is unset and
 * the success / error paths when it is set. Fetch is stubbed so no network call
 * is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe("ai.service.ask — stub fallback (no API key)", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("returns stub response with source=stub", async () => {
    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("Anything");
    expect(result.source).toBe("stub");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.tip).toBeTruthy();
  });
});

describe("ai.service.ask — OpenAI path", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("returns parsed rows + tip on successful response", async () => {
    const payload = {
      rows: [
        { label: "Animation", a: "Studio MAPPA", b: "Studio Bones", delta: "tie", good: "tie" },
      ],
      tip: "Both are excellent.",
      summary: "Quick compare.",
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }) as unknown as typeof fetch;

    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("Compare MAPPA vs Bones");
    expect(result.source).toBe("openai");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe("Animation");
    expect(result.tip).toBe("Both are excellent.");
    expect(result.summary).toBe("Quick compare.");
  });

  it("clamps rows to at most 8", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      label: `r${i}`,
      a: "x",
      b: "y",
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ rows }) } }],
      }),
    }) as unknown as typeof fetch;

    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("many rows please");
    expect(result.rows).toHaveLength(8);
  });

  it("falls back to stub when OpenAI returns non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("Anything");
    expect(result.source).toBe("stub");
  });

  it("falls back to stub when message content is invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "this is not json" } }],
      }),
    }) as unknown as typeof fetch;

    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("Anything");
    expect(result.source).toBe("stub");
  });

  it("falls back to stub when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const { ask } = await import("../app/src/modules/ai/ai.service");
    const result = await ask("Anything");
    expect(result.source).toBe("stub");
  });
});
