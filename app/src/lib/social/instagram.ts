/**
 * Instagram integration — "Instagram API with Instagram Login" (the current
 * Graph-based flow; Basic Display was deprecated Dec 2024). Lets a creator
 * connect their Instagram (Business/Creator) account and pull their Reels so
 * we can re-host them into Kaiveron Shots.
 *
 * Entirely INERT until INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET are set — every
 * exported call throws configError until then, so the studio shows a graceful
 * "connect not available yet" state instead of erroring.
 *
 * Setup (platform owner): create a Meta app → add "Instagram" product → use
 * Instagram API with Instagram Login → add the OAuth redirect URI
 *   https://api.kaiveron.com/api/v1/social/instagram/callback
 * → request scopes instagram_business_basic. App review is required before
 * non-test users can connect.
 */
import { env } from "../../config/env";
import { configError, badRequest } from "../errors";

const AUTH_BASE = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
// Default scope reads the creator's own media (incl. Reels). Override via
// INSTAGRAM_SCOPES if Meta requires more (e.g. add instagram_business_content_publish).
const SCOPES = env.INSTAGRAM_SCOPES || "instagram_business_basic";

/**
 * Thrown when Instagram rejects the token itself (OAuthException / code 190) —
 * i.e. the connection genuinely needs the user to reconnect, as opposed to a
 * transient network/5xx error. Callers use this to decide refresh-vs-reconnect
 * instead of surfacing a vague "token may have expired".
 */
export class IgAuthError extends Error {
  constructor(message = "Instagram authorization expired") {
    super(message);
    this.name = "IgAuthError";
  }
}

/** True when an Instagram error payload means the access token is invalid/expired. */
function isAuthErrorBody(text: string): boolean {
  try {
    const j = JSON.parse(text) as { error?: { type?: string; code?: number } };
    const e = j.error;
    return !!e && (e.type === "OAuthException" || e.code === 190 || e.code === 102 || e.code === 10);
  } catch {
    return /OAuthException|access token|expired|invalid.*token/i.test(text);
  }
}

/** Human-readable message from an Instagram error payload (falls back to raw). */
function igErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: number; error_user_msg?: string } };
    const e = j.error;
    return e?.error_user_msg || e?.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export function isConfigured(): boolean {
  return Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
}

function assertConfigured(): void {
  if (!isConfigured()) throw configError("Instagram is not configured on this server yet");
}

export function redirectUri(): string {
  if (env.INSTAGRAM_REDIRECT_URI) return env.INSTAGRAM_REDIRECT_URI;
  const base = env.OAUTH_CALLBACK_BASE.replace(/\/$/, "");
  if (!base) throw configError("Set INSTAGRAM_REDIRECT_URI or OAUTH_CALLBACK_BASE");
  return `${base}/api/v1/social/instagram/callback`;
}

/** OAuth dialog URL the creator is sent to in order to authorize Kaiveron. */
export function getAuthUrl(state: string): string {
  assertConfigured();
  const p = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

export interface IgConnection {
  providerUserId: string;
  username: string | null;
  accessToken: string;
  expiresInSec: number | null;
}

/** Exchange the OAuth code for a long-lived token + the connected account. */
export async function exchangeCode(code: string): Promise<IgConnection> {
  assertConfigured();

  // 1. code → short-lived token (+ user_id)
  const form = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code,
  });
  const shortRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!shortRes.ok) throw badRequest(`Instagram token exchange failed: ${await shortRes.text()}`);
  const short = (await shortRes.json()) as { access_token: string; user_id: string | number };

  // 2. short-lived → long-lived token (~60 days)
  const longRes = await fetch(
    `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.INSTAGRAM_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`,
  );
  const long = longRes.ok
    ? ((await longRes.json()) as { access_token: string; expires_in: number })
    : { access_token: short.access_token, expires_in: 0 };

  // 3. fetch handle for display
  let username: string | null = null;
  try {
    const meRes = await fetch(`${GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`);
    if (meRes.ok) username = ((await meRes.json()) as { username?: string }).username ?? null;
  } catch { /* non-fatal */ }

  return {
    providerUserId: String(short.user_id),
    username,
    accessToken: long.access_token,
    expiresInSec: long.expires_in || null,
  };
}

/**
 * Refresh a long-lived token, extending it another ~60 days. Instagram allows
 * this once the token is ≥24h old and NOT yet expired; an already-expired or
 * revoked token can't be refreshed (the user must reconnect). Returns the new
 * token + lifetime on success, or null when refresh isn't possible.
 */
export async function refreshLongLivedToken(
  accessToken: string,
): Promise<{ accessToken: string; expiresInSec: number } | null> {
  assertConfigured();
  try {
    const res = await fetch(
      `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!d.access_token) return null;
    return { accessToken: d.access_token, expiresInSec: d.expires_in ?? 0 };
  } catch {
    return null;
  }
}

export interface IgReel {
  externalId: string;
  caption: string | null;
  mediaUrl: string;        // CDN video URL (time-limited — re-host on import)
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

/** List the connected account's Reels (most recent first). */
export async function listReels(accessToken: string, limit = 25): Promise<IgReel[]> {
  assertConfigured();
  const fields = "id,media_type,media_product_type,media_url,thumbnail_url,caption,permalink,timestamp";
  const url = `${GRAPH}/me/media?fields=${fields}&limit=${Math.min(limit, 50)}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    if (isAuthErrorBody(text)) throw new IgAuthError(igErrorMessage(text));
    throw badRequest(`Instagram media fetch failed: ${igErrorMessage(text)}`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string; media_type?: string; media_product_type?: string;
      media_url?: string; thumbnail_url?: string; caption?: string;
      permalink?: string; timestamp?: string;
    }>;
  };
  return (body.data ?? [])
    .filter((m) => m.media_type === "VIDEO" && !!m.media_url)
    .map((m) => ({
      externalId: m.id,
      caption: m.caption ?? null,
      mediaUrl: m.media_url as string,
      thumbnailUrl: m.thumbnail_url ?? null,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? null,
    }));
}

// Instagram/Facebook media is only ever served from these CDN hosts. Pinning to
// them prevents a spoofed/compromised Graph response from pointing downloadMedia
// at an internal host (SSRF) or an oversized body.
const IG_MEDIA_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

/** Fetch the raw bytes of a media URL so we can re-host it permanently. */
export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  let u: URL;
  try { u = new URL(mediaUrl); } catch { throw badRequest("Invalid media URL"); }
  if (u.protocol !== "https:" || !IG_MEDIA_HOST.test(u.hostname)) {
    throw badRequest("Unsupported media host");
  }
  const res = await fetch(u.toString(), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw badRequest("Failed to download Instagram media");
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_MEDIA_BYTES) throw badRequest("Instagram media too large");
  const arr = await res.arrayBuffer();
  if (arr.byteLength > MAX_MEDIA_BYTES) throw badRequest("Instagram media too large");
  return Buffer.from(arr);
}
