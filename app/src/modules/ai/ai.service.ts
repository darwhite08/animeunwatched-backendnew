/**
 * Minimal AI ask endpoint.
 *
 * If OPENAI_API_KEY is set, proxies the prompt to the OpenAI Responses API
 * with a system prompt that constrains it to anime-related answers and a
 * structured-output format matching what the web `AIResponseBubble` expects:
 *
 *   { rows: [{ label, a, b, delta, good }], tip?: string }
 *
 * If no key is configured, returns a friendly fallback so the UI can still
 * render something useful.
 */

export type AIRow = {
  label: string;
  a: string;
  b: string;
  delta?: string;
  good?: "a" | "b" | "tie";
};

export type AIResponse = {
  rows: AIRow[];
  tip?: string;
  summary?: string;
  source: "openai" | "stub";
};

const SYSTEM_PROMPT = `You are Kaiveron's in-chat AI oracle. The user is comparing or asking about anime.
Respond with concise side-by-side rows when comparing two things. Always include a one-line "tip".
Return STRICT JSON only with shape:
{
  "rows": [{ "label": "string", "a": "string", "b": "string", "delta": "string?", "good": "a|b|tie?" }],
  "tip": "string?",
  "summary": "string?"
}
No prose outside JSON.`;

const FALLBACK: AIResponse = {
  summary: "AI oracle isn't fully wired up yet on this server.",
  rows: [
    { label: "Status", a: "Stub mode", b: "OpenAI key not set", delta: "—", good: "tie" },
    { label: "What works", a: "All chat features", b: "Real-time + E2E", good: "tie" },
  ],
  tip: "Ask the admin to set OPENAI_API_KEY on the backend to enable rich answers.",
  source: "stub",
};

export async function ask(prompt: string): Promise<AIResponse> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return FALLBACK;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.5,
        max_tokens: 600,
      }),
    });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return FALLBACK;
    let parsed: Partial<AIResponse>;
    try {
      parsed = JSON.parse(content) as Partial<AIResponse>;
    } catch {
      return FALLBACK;
    }
    return {
      rows: Array.isArray(parsed.rows) ? parsed.rows.slice(0, 8) : [],
      tip: typeof parsed.tip === "string" ? parsed.tip : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      source: "openai",
    };
  } catch {
    return FALLBACK;
  }
}
