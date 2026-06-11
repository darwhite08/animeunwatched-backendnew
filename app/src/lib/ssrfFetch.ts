import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-hardened server-side fetch for user-supplied URLs (link unfurl, etc).
 *
 * Closes the gaps a string-prefix host blocklist leaves open:
 *   - resolves the hostname and rejects any address in a private / loopback /
 *     link-local / ULA / CGNAT / multicast / reserved range (defeats
 *     DNS-rebinding and decimal/hex/IPv6-encoded internal IPs),
 *   - follows redirects MANUALLY and re-validates every hop (defeats
 *     redirect-to-internal SSRF — the classic IMDS / internal-service pivot),
 *   - enforces http(s) only, a hop cap, a timeout, and a streamed byte cap.
 *
 * Use this for ANY fetch of a URL that originates from request input.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** True if an IP literal falls in a range that must never be reached server-side. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal → refuse
}

function isBlockedIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                                  // 0.0.0.0/8
  if (a === 10) return true;                                 // 10/8 private
  if (a === 127) return true;                                // loopback
  if (a === 169 && b === 254) return true;                   // link-local (incl. 169.254.169.254 IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12 private
  if (a === 192 && b === 168) return true;                   // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64/10 CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true;       // 192.0.0/24 reserved
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18/15 benchmarking
  if (a >= 224) return true;                                 // 224/4 multicast + 240/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true;                // loopback / unspecified
  // IPv4-mapped / -compatible (::ffff:127.0.0.1, ::ffff:a9fe:a9fe, etc.) → check embedded v4
  const mapped = h.match(/::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const hexMapped = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const a = parseInt(hexMapped[1], 16), b = parseInt(hexMapped[2], 16);
    return isBlockedIpv4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true;                         // fc00::/7 unique-local
  if (h.startsWith("ff")) return true;                       // ff00::/8 multicast
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  // Literal IP in the URL → validate directly (no DNS).
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError("URL resolves to a non-public address");
    return;
  }
  // Hostname → resolve ALL addresses and reject if ANY is internal (rebind defense).
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError("Could not resolve host");
  }
  if (!addrs.length) throw new SsrfError("Could not resolve host");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new SsrfError("URL resolves to a non-public address");
  }
}

export interface SsrfFetchOpts {
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

/**
 * Fetch with manual, per-hop SSRF validation. Returns the final Response (body
 * unread) so the caller can stream it with its own byte cap (use readTextCapped).
 */
export async function ssrfSafeFetch(rawUrl: string, opts: SsrfFetchOpts = {}): Promise<Response> {
  const { timeoutMs = 6000, maxRedirects = 4, headers = {} } = opts;
  let current = rawUrl;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let u: URL;
      try { u = new URL(current); } catch { throw new SsrfError("Invalid URL"); }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("Only http(s) URLs are supported");
      await assertPublicHost(u.hostname);

      const res = await fetch(u.toString(), {
        signal: ac.signal,
        redirect: "manual",
        headers: { "User-Agent": "KaiveronBot/1.0 (+https://kaiveron.com)", ...headers },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return res; // redirect with no target — hand back as-is
        if (hop === maxRedirects) throw new SsrfError("Too many redirects");
        current = new URL(loc, u).toString(); // re-validated at the top of the next iteration
        continue;
      }
      return res;
    }
    throw new SsrfError("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as text, aborting once maxBytes is exceeded (DoS cap). */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (seen >= maxBytes) { void reader.cancel(); break; }
  }
  return out;
}
