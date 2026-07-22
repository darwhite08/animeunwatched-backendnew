/**
 * Groq (OpenAI-compatible) chat client. Used by AI Discover for query
 * understanding + reranking. Mirrors the callOpenAI pattern in modules/ai but
 * points at Groq's endpoint and forces JSON mode.
 *
 * All calls are best-effort: on a missing key, timeout, non-2xx, or unparseable
 * body they resolve to `null` so callers can degrade gracefully instead of
 * failing the request. Never throws.
 */
import { env } from "../config/env";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function groqEnabled(): boolean {
  return !!env.GROQ_API_KEY;
}

export interface GroqOpts {
  /** Lower = more deterministic. Discover parsing wants tight, repeatable output. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
}

/**
 * Chat completion that returns the raw assistant text, or null on any failure.
 */
export async function groqChat(
  system: string,
  user: string,
  opts: GroqOpts = {},
): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: opts.model || env.GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 800,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) {
      console.warn(`[groq] ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn("[groq] request failed:", (err as Error).message);
    return null;
  }
}

/**
 * Chat completion parsed as JSON of type T, or null on any failure (including
 * malformed JSON). The model is always in JSON mode, but we still guard the parse.
 */
export async function groqJSON<T>(system: string, user: string, opts: GroqOpts = {}): Promise<T | null> {
  const raw = await groqChat(system, user, opts);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Occasionally a model wraps JSON in prose despite json_object mode — salvage
    // the first {...} block.
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]) as T; } catch { /* fall through */ }
    }
    console.warn("[groq] JSON parse failed");
    return null;
  }
}
