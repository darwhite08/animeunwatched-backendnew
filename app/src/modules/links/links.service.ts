import { badRequest } from "../../lib/errors";
import { ssrfSafeFetch, readTextCapped, SsrfError } from "../../lib/ssrfFetch";

// ─── Link unfurl (Open Graph preview) ───────────────────────────────────────
// Fetches a URL server-side and extracts OG/Twitter/meta tags so the blog editor
// can render a rich link-preview card (Word/Notion style). Lightweight regex
// parse — no headless browser. SSRF-hardened via ssrfSafeFetch: resolves the
// host + re-validates every redirect hop against private/internal ranges.

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
}

function pick(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decode(m[1].trim());
  }
  return null;
}
function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x2F;/g, "/");
}
function meta(prop: string): RegExp[] {
  return [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
}

export async function unfurl(rawUrl: string): Promise<LinkPreview> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw badRequest("Invalid URL"); }
  if (!/^https?:$/.test(u.protocol)) throw badRequest("Only http(s) URLs are supported");

  let html = "";
  try {
    const res = await ssrfSafeFetch(u.toString(), {
      timeoutMs: 6000,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw badRequest(`Could not load that link (${res.status})`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) {
      void res.body?.cancel();
      return { url: u.toString(), title: u.hostname, description: null, image: null, siteName: u.hostname, favicon: null };
    }
    html = await readTextCapped(res, 200_000); // streamed parse cap (no full-body buffer)
  } catch (e) {
    if (e instanceof SsrfError) throw badRequest("That host isn't allowed");
    if (e instanceof Error && e.name === "AbortError") throw badRequest("That link timed out");
    throw e;
  }

  const title =
    pick(html, [...meta("og:title"), ...meta("twitter:title")]) ??
    pick(html, [/<title[^>]*>([^<]+)<\/title>/i]);
  const description = pick(html, [...meta("og:description"), ...meta("twitter:description"), ...meta("description")]);
  let image = pick(html, [...meta("og:image:secure_url"), ...meta("og:image"), ...meta("twitter:image")]);
  const siteName = pick(html, [...meta("og:site_name")]) ?? u.hostname.replace(/^www\./, "");

  if (image && image.startsWith("/")) image = `${u.origin}${image}`;
  const favicon = `${u.origin}/favicon.ico`;

  return { url: u.toString(), title: title ?? u.hostname, description, image, siteName, favicon };
}
