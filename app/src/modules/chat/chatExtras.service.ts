import { cache } from "../../lib/cache";
import { env } from "../../config/env";
import { badReq } from "../../lib/errors";
import { ssrfSafeFetch, readTextCapped, SsrfError } from "../../lib/ssrfFetch";

// ─── Link preview (Open Graph) ──────────────────────────────────────────────
// SSRF-hardened server-side fetch (ssrfSafeFetch: resolves host + re-validates
// every redirect hop against private/internal ranges), timeout + size cap.
// Cached 1h. The client never fetches cross-origin itself.

function ogTag(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1];
}

export async function linkPreview(rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw badReq("Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badReq("Unsupported URL");

  const key = `linkpreview:${url.href}`;
  const cached = cache.get<object>(key);
  if (cached) return cached;

  try {
    const res = await ssrfSafeFetch(url.href, { timeoutMs: 5000, headers: { Accept: "text/html" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/html")) {
      void res.body?.cancel();
      const empty = { url: url.href, title: null, description: null, image: null };
      cache.set(key, empty, 60 * 60_000);
      return empty;
    }
    // Read at most ~512KB of HTML (OG tags live in <head>).
    let html = await readTextCapped(res, 512 * 1024);
    const headEnd = html.indexOf("</head>");
    if (headEnd !== -1) html = html.slice(0, headEnd + 7);
    const preview = {
      url: url.href,
      title: ogTag(html, "og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null,
      description: ogTag(html, "og:description") ?? ogTag(html, "description") ?? null,
      image: ogTag(html, "og:image") ?? null,
      siteName: ogTag(html, "og:site_name") ?? url.hostname,
    };
    cache.set(key, preview, 60 * 60_000);
    return preview;
  } catch (e) {
    if (e instanceof SsrfError) throw badReq("URL not allowed");
    const empty = { url: url.href, title: null, description: null, image: null };
    cache.set(key, empty, 10 * 60_000);
    return empty;
  }
}

// ─── GIF search (Tenor proxy) ───────────────────────────────────────────────
// Keeps the API key server-side. Returns [] gracefully when TENOR_API_KEY is
// unset so the picker degrades instead of erroring.

export async function searchGifs(q: string, limit = 24) {
  const key = env.TENOR_API_KEY;
  if (!key) return { results: [] as { id: string; url: string; preview: string; width: number; height: number }[] };
  const term = q.trim();
  const cacheKey = `gifs:${term || "trending"}:${limit}`;
  const cached = cache.get<{ results: unknown[] }>(cacheKey);
  if (cached) return cached;
  const base = term
    ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(term)}`
    : "https://tenor.googleapis.com/v2/featured?";
  const url = `${base}&key=${key}&client_key=kaiveron&limit=${limit}&media_filter=tinygif,gif`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { results: [] };
    const data = (await res.json()) as { results: { id: string; media_formats: Record<string, { url: string; dims: number[] }> }[] };
    const results = (data.results ?? []).map((r) => {
      const gif = r.media_formats.gif ?? r.media_formats.tinygif;
      const tiny = r.media_formats.tinygif ?? gif;
      return { id: r.id, url: gif?.url, preview: tiny?.url, width: gif?.dims?.[0] ?? 0, height: gif?.dims?.[1] ?? 0 };
    }).filter((r) => r.url);
    const out = { results };
    cache.set(cacheKey, out, 30 * 60_000);
    return out;
  } catch {
    return { results: [] };
  }
}
