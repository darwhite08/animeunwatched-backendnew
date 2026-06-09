/**
 * TikTok integration — TikTok Login Kit + Display API (v2).
 *
 * Unlike Instagram, TikTok's Display API does NOT expose downloadable video
 * files — only metadata + an embed link. So imported TikToks become EMBED Shots
 * (rendered via TikTok's player), not re-hosted MP4s. Re-hosting would require
 * unofficial scraping (against TikTok ToS) — we don't do that.
 *
 * INERT until TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET are set.
 *
 * Setup (platform owner): create a TikTok developer app at developers.tiktok.com
 * → add Login Kit + Display API → scopes `user.info.basic`, `video.list` → add
 * the redirect URI https://api.kaiveron.com/api/v1/social/tiktok/callback → submit
 * for App Review (videos of your own account work in sandbox before review).
 */
import { env } from "../../config/env";
import { configError, badRequest } from "../errors";

const AUTH_BASE = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const API_BASE = "https://open.tiktokapis.com/v2";
const SCOPES = "user.info.basic,video.list";

export function isConfigured(): boolean {
  return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
}

function assertConfigured(): void {
  if (!isConfigured()) throw configError("TikTok is not configured on this server yet");
}

export function redirectUri(): string {
  if (env.TIKTOK_REDIRECT_URI) return env.TIKTOK_REDIRECT_URI;
  const base = env.OAUTH_CALLBACK_BASE.replace(/\/$/, "");
  if (!base) throw configError("Set TIKTOK_REDIRECT_URI or OAUTH_CALLBACK_BASE");
  return `${base}/api/v1/social/tiktok/callback`;
}

export function getAuthUrl(state: string): string {
  assertConfigured();
  const p = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

export interface TtConnection {
  providerUserId: string; // open_id
  username: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
}

/** Exchange the OAuth code for tokens + the connected account. */
export async function exchangeCode(code: string): Promise<TtConnection> {
  assertConfigured();
  const form = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: form.toString(),
  });
  if (!res.ok) throw badRequest(`TikTok token exchange failed: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; open_id: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token) throw badRequest("TikTok did not return an access token");

  // Best-effort display name
  let username: string | null = null;
  try {
    const me = await fetch(`${API_BASE}/user/info/?fields=open_id,display_name`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (me.ok) username = ((await me.json()) as { data?: { user?: { display_name?: string } } }).data?.user?.display_name ?? null;
  } catch { /* non-fatal */ }

  return {
    providerUserId: t.open_id,
    username,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresInSec: t.expires_in ?? null,
  };
}

export interface TtVideo {
  externalId: string;
  caption: string | null;
  coverUrl: string | null;
  embedUrl: string | null;   // TikTok player URL
  shareUrl: string | null;
  duration: number | null;   // seconds
}

/** List the connected account's videos (metadata + embed link; no MP4). */
export async function listVideos(accessToken: string, max = 20): Promise<TtVideo[]> {
  assertConfigured();
  const fields = "id,title,video_description,cover_image_url,embed_link,share_url,duration";
  const res = await fetch(`${API_BASE}/video/list/?fields=${encodeURIComponent(fields)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_count: Math.min(max, 20) }),
  });
  if (!res.ok) throw badRequest(`TikTok video list failed: ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { videos?: Array<{ id: string; title?: string; video_description?: string; cover_image_url?: string; embed_link?: string; share_url?: string; duration?: number }> };
  };
  return (body.data?.videos ?? []).map((v) => ({
    externalId: v.id,
    caption: v.title || v.video_description || null,
    coverUrl: v.cover_image_url ?? null,
    embedUrl: v.embed_link || `https://www.tiktok.com/embed/v2/${v.id}`,
    shareUrl: v.share_url ?? null,
    duration: v.duration ?? null,
  }));
}
