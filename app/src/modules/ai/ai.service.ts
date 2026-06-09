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

// ─── AI writing assistant (Creator Studio blog editor) ──────────────────────
// Prefers Anthropic (Claude) → falls back to OpenAI → graceful stub. Returns a
// clean semantic-HTML fragment ready to insert into the TipTap editor.

export type WriteResult = { html: string; text: string; source: "anthropic" | "openai" | "stub" };

const WRITE_SYSTEM = `You are a world-class writing assistant for Kaiveron, an anime blogging platform.
Return ONLY a clean semantic HTML fragment — no <html>/<head>/<body>, no markdown code fences.
Use <h2>, <h3>, <p>, <ul>/<ol>/<li>, <blockquote>, <strong>, <em> appropriately.
Voice: sharp, knowledgeable, engaging for anime fans. Never include images or scripts.`;

function instruction(action: string, prompt: string, context: string): string {
  switch (action) {
    case "draft":    return `Write an engaging, well-structured blog section about: "${prompt}". Use a couple of headings and flowing paragraphs.`;
    case "continue": return `Continue this blog naturally where it leaves off, matching the voice. Do not repeat existing text.\n\nDRAFT:\n${context}`;
    case "improve":  return `Rewrite the following to improve clarity, flow, rhythm and impact while preserving meaning:\n\n${context}`;
    case "fix":      return `Correct grammar, spelling and punctuation with minimal changes. Return the corrected text:\n\n${context}`;
    case "shorten":  return `Make the following more concise and punchy without losing key points:\n\n${context}`;
    case "expand":   return `Expand the following with more detail, examples and depth:\n\n${context}`;
    case "titles":   return `Suggest 6 catchy, specific blog titles for this topic/draft. Return ONLY a <ul> with one <li> per title.\n\n${context || prompt}`;
    default:         return prompt || context;
  }
}

function stripFences(s: string): string {
  return s.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
}
function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function callAnthropic(userMsg: string, system: string = WRITE_SYSTEM, maxTokens = 1500): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return text || null;
  } catch { return null; }
}

async function callOpenAI(userMsg: string, system: string = WRITE_SYSTEM, maxTokens = 1500): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

/**
 * Generic short-form LLM call: tries Anthropic (Claude) → OpenAI → null.
 * Used for classification/extraction tasks (e.g. picking the official trailer
 * from a list of YouTube candidates). Returns the raw model text or null when
 * no AI key is configured.
 */
export async function askLLM(system: string, user: string, maxTokens = 200): Promise<string | null> {
  return (await callAnthropic(user, system, maxTokens)) ?? (await callOpenAI(user, system, maxTokens));
}

export async function write(action: string, prompt: string, context: string): Promise<WriteResult> {
  const userMsg = instruction(action, prompt, context);

  const fromClaude = await callAnthropic(userMsg);
  if (fromClaude) { const html = stripFences(fromClaude); return { html, text: htmlToText(html), source: "anthropic" }; }

  const fromOpenAI = await callOpenAI(userMsg);
  if (fromOpenAI) { const html = stripFences(fromOpenAI); return { html, text: htmlToText(html), source: "openai" }; }

  const stub = `<p><em>AI writing isn't configured on this server yet.</em> Ask the admin to set <code>ANTHROPIC_API_KEY</code> (or <code>OPENAI_API_KEY</code>) to enable drafting, polishing and title ideas.</p>`;
  return { html: stub, text: htmlToText(stub), source: "stub" };
}

// ─── Translation (reuses the AI key — same ANTHROPIC/OPENAI_API_KEY) ─────────

export const TRANSLATE_LANGS: Record<string, string> = {
  es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian",
  ja: "Japanese", ko: "Korean", zh: "Chinese (Simplified)", hi: "Hindi",
  ar: "Arabic", ru: "Russian", id: "Indonesian", tr: "Turkish", vi: "Vietnamese",
  th: "Thai", fil: "Filipino", bn: "Bengali", en: "English",
};

export type TranslateResult = { text: string; source: "anthropic" | "openai" | "stub"; lang: string };

/** Translate text (optionally HTML) into a target language via the AI provider. */
export async function translate(text: string, targetLang: string, isHtml = false): Promise<TranslateResult> {
  const lang = TRANSLATE_LANGS[targetLang] ?? targetLang;
  const sys = `You are a professional translator. Translate the user's content into ${lang}.${isHtml ? " The content is HTML — preserve every tag, attribute and structure EXACTLY; translate only the human-readable text between tags." : ""} Output ONLY the translation — no preamble, no notes, no code fences. Keep proper nouns, anime titles and @mentions unchanged.`;
  const budget = Math.min(4000, Math.max(800, Math.ceil(text.length / 2)));

  const fromClaude = await callAnthropic(text, sys, budget);
  if (fromClaude) return { text: stripFences(fromClaude), source: "anthropic", lang };
  const fromOpenAI = await callOpenAI(text, sys, budget);
  if (fromOpenAI) return { text: stripFences(fromOpenAI), source: "openai", lang };
  return { text, source: "stub", lang }; // not configured → return original unchanged
}

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
