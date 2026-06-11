import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { notFound, badRequest } from "../../lib/errors";
import { uploadImageBuffer } from "../../lib/storage";
import * as ig from "../../lib/social/instagram";
import * as tt from "../../lib/social/tiktok";
import * as shots from "../shots/shots.service";

// ─── OAuth state (stateless, signed) ────────────────────────────────────────
// The provider callback has no auth header, so we carry the userId in a
// short-lived signed state param and verify it on return — no session store.

function signState(userId: string, provider: string): string {
  return jwt.sign({ userId, p: provider }, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
}
function verifyState(state: string, provider: string): string {
  try {
    const d = jwt.verify(state, env.JWT_ACCESS_SECRET) as { userId: string; p: string };
    if (d.p !== provider || !d.userId) throw new Error("bad state");
    return d.userId;
  } catch {
    throw badRequest("Invalid or expired connect link");
  }
}

// ─── Connections ────────────────────────────────────────────────────────────

export function instagramAvailable(): boolean {
  return ig.isConfigured();
}
export function tiktokAvailable(): boolean {
  return tt.isConfigured();
}

export async function listConnections(userId: string) {
  const rows = await prisma.socialConnection.findMany({
    where: { userId },
    select: { provider: true, username: true, providerUserId: true, tokenExpiresAt: true, createdAt: true },
  });
  const now = Date.now();
  return {
    instagramAvailable: ig.isConfigured(),
    tiktokAvailable: tt.isConfigured(),
    connections: rows.map((r) => ({
      provider: r.provider,
      username: r.username,
      connectedAt: r.createdAt.toISOString(),
      expiresAt: r.tokenExpiresAt?.toISOString() ?? null,
      // True when the stored token is already past expiry → the user must
      // reconnect (the UI shows a Reconnect CTA instead of a vague error).
      needsReauth: !!r.tokenExpiresAt && r.tokenExpiresAt.getTime() <= now,
    })),
  };
}

// ─── Instagram token lifecycle ──────────────────────────────────────────────
// Long-lived IG tokens last ~60 days but renew (+60d) each time they're
// refreshed before expiry — so as long as we keep refreshing, the connection
// never dies. We refresh both proactively (daily job) and lazily (right before
// a read), and only fall back to "reconnect" when IG actually rejects the token.

const IG_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60_000; // refresh when <14 days left
const IG_REAUTH_SENTINEL = new Date(0);             // past expiry = "needs reconnect"

type IgConn = NonNullable<Awaited<ReturnType<typeof getInstagram>>>;

/** Persist a refreshed token (or mark the connection as needing reconnect). */
async function refreshInstagramToken(conn: IgConn): Promise<IgConn> {
  const refreshed = await ig.refreshLongLivedToken(conn.accessToken);
  if (!refreshed) return conn; // refresh not possible (too fresh / transient) — keep current
  const expiresAt = refreshed.expiresInSec
    ? new Date(Date.now() + refreshed.expiresInSec * 1000)
    : conn.tokenExpiresAt;
  return prisma.socialConnection.update({
    where: { userId_provider: { userId: conn.userId, provider: "instagram" } },
    data: { accessToken: refreshed.accessToken, tokenExpiresAt: expiresAt },
  });
}

/** Refresh the token ahead of expiry so reads never hit an expired token. */
async function ensureFreshInstagram(conn: IgConn): Promise<IgConn> {
  if (!conn.tokenExpiresAt) return conn;
  const msLeft = conn.tokenExpiresAt.getTime() - Date.now();
  if (msLeft > IG_REFRESH_WINDOW_MS) return conn; // plenty of life left
  return refreshInstagramToken(conn);
}

async function markInstagramNeedsReauth(userId: string): Promise<void> {
  await prisma.socialConnection.updateMany({
    where: { userId, provider: "instagram" },
    data: { tokenExpiresAt: IG_REAUTH_SENTINEL },
  });
}

/** Build the Instagram OAuth dialog URL for this creator. */
export function startInstagramConnect(userId: string): { url: string } {
  return { url: ig.getAuthUrl(signState(userId, "instagram")) };
}

/** Handle the OAuth redirect: verify state, exchange code, store the token. */
export async function handleInstagramCallback(code: string, state: string): Promise<{ userId: string }> {
  const userId = verifyState(state, "instagram");
  const conn = await ig.exchangeCode(code);
  const expiresAt = conn.expiresInSec ? new Date(Date.now() + conn.expiresInSec * 1000) : null;

  await prisma.socialConnection.upsert({
    where: { userId_provider: { userId, provider: "instagram" } },
    create: {
      userId, provider: "instagram", providerUserId: conn.providerUserId,
      username: conn.username, accessToken: conn.accessToken, tokenExpiresAt: expiresAt,
      scopes: ["instagram_business_basic"],
    },
    update: {
      providerUserId: conn.providerUserId, username: conn.username,
      accessToken: conn.accessToken, tokenExpiresAt: expiresAt,
    },
  });
  return { userId };
}

async function getInstagram(userId: string) {
  const conn = await prisma.socialConnection.findUnique({
    where: { userId_provider: { userId, provider: "instagram" } },
  });
  if (!conn) throw notFound("Instagram is not connected");
  return conn;
}

/**
 * Fetch reels with auto-recovery: refresh the token if it's near/at expiry,
 * and if IG still rejects it, force one refresh + retry. Only when that also
 * fails do we mark the connection for reconnect and surface a clear message.
 */
async function igReelsResilient(conn: IgConn, limit?: number) {
  const active = await ensureFreshInstagram(conn);
  try {
    return await ig.listReels(active.accessToken, limit);
  } catch (e) {
    if (!(e instanceof ig.IgAuthError)) throw e;
    const refreshed = await refreshInstagramToken(active);
    if (refreshed.accessToken !== active.accessToken) {
      try {
        return await ig.listReels(refreshed.accessToken, limit);
      } catch (e2) {
        if (!(e2 instanceof ig.IgAuthError)) throw e2;
      }
    }
    await markInstagramNeedsReauth(conn.userId);
    throw badRequest("Instagram needs to be reconnected — please connect again.");
  }
}

/** List the creator's IG reels, flagged with whether each is already imported. */
export async function listInstagramReels(userId: string) {
  const conn = await getInstagram(userId);
  const reels = await igReelsResilient(conn);
  const imported = await prisma.importedMedia.findMany({
    where: { userId, provider: "instagram", externalId: { in: reels.map((r) => r.externalId) } },
    select: { externalId: true, shotId: true },
  });
  const map = new Map(imported.map((i) => [i.externalId, i.shotId]));
  return {
    username: conn.username,
    reels: reels.map((r) => ({
      id: r.externalId,
      caption: r.caption,
      thumbnailUrl: r.thumbnailUrl,
      permalink: r.permalink,
      timestamp: r.timestamp,
      imported: map.has(r.externalId),
      shotId: map.get(r.externalId) ?? null,
    })),
  };
}

/** Import selected reels → re-host to our storage → create Shots. Idempotent. */
export async function importInstagramReels(userId: string, externalIds: string[]) {
  if (!externalIds.length) throw badRequest("Select at least one reel to import");
  const conn = await getInstagram(userId);
  const reels = await igReelsResilient(conn, 50);
  const wanted = reels.filter((r) => externalIds.includes(r.externalId));
  if (!wanted.length) throw badRequest("None of the selected reels were found");

  const results: { externalId: string; shotId?: string; status: "imported" | "skipped" | "failed"; error?: string }[] = [];

  for (const reel of wanted) {
    try {
      const existing = await prisma.importedMedia.findUnique({
        where: { userId_provider_externalId: { userId, provider: "instagram", externalId: reel.externalId } },
      });
      if (existing?.shotId) { results.push({ externalId: reel.externalId, shotId: existing.shotId, status: "skipped" }); continue; }

      // Re-host the video to our own storage so it survives IG's CDN expiry.
      const bytes = await ig.downloadMedia(reel.mediaUrl);
      const { publicUrl } = await uploadImageBuffer({
        userId, scope: "shot", contentType: "video/mp4", ext: "mp4", body: bytes,
      });

      const shot = await shots.createShot(userId, {
        videoUrl: publicUrl,
        ...(reel.thumbnailUrl ? { thumbnailUrl: reel.thumbnailUrl } : {}),
        ...(reel.caption ? { caption: reel.caption.slice(0, 2200) } : {}),
      });

      await prisma.importedMedia.upsert({
        where: { userId_provider_externalId: { userId, provider: "instagram", externalId: reel.externalId } },
        create: { userId, provider: "instagram", externalId: reel.externalId, shotId: shot.id, permalink: reel.permalink },
        update: { shotId: shot.id },
      });
      results.push({ externalId: reel.externalId, shotId: shot.id, status: "imported" });
    } catch (e) {
      results.push({ externalId: reel.externalId, status: "failed", error: e instanceof Error ? e.message : "import failed" });
    }
  }

  const imported = results.filter((r) => r.status === "imported").length;
  return { imported, skipped: results.filter((r) => r.status === "skipped").length, failed: results.filter((r) => r.status === "failed").length, results };
}

export async function disconnectInstagram(userId: string) {
  await prisma.socialConnection.deleteMany({ where: { userId, provider: "instagram" } });
  return { disconnected: true };
}

/**
 * Background refresh: renew every Instagram token that's within the refresh
 * window so connections never lapse. Already-expired tokens are skipped — they
 * can't be refreshed and need a reconnect. Returns counts for the job log.
 */
export async function refreshExpiringInstagramTokens(): Promise<{ scanned: number; refreshed: number; skipped: boolean }> {
  if (!ig.isConfigured()) return { scanned: 0, refreshed: 0, skipped: true };
  const now = new Date();
  const horizon = new Date(now.getTime() + IG_REFRESH_WINDOW_MS);
  const rows = await prisma.socialConnection.findMany({
    where: { provider: "instagram", tokenExpiresAt: { gt: now, lte: horizon } },
  });
  let refreshed = 0;
  for (const conn of rows) {
    const updated = await refreshInstagramToken(conn);
    if (updated.accessToken !== conn.accessToken) refreshed++;
  }
  return { scanned: rows.length, refreshed, skipped: false };
}

// ─── TikTok (embed import) ──────────────────────────────────────────────────

export function startTiktokConnect(userId: string): { url: string } {
  return { url: tt.getAuthUrl(signState(userId, "tiktok")) };
}

export async function handleTiktokCallback(code: string, state: string): Promise<{ userId: string }> {
  const userId = verifyState(state, "tiktok");
  const conn = await tt.exchangeCode(code);
  const expiresAt = conn.expiresInSec ? new Date(Date.now() + conn.expiresInSec * 1000) : null;
  await prisma.socialConnection.upsert({
    where: { userId_provider: { userId, provider: "tiktok" } },
    create: {
      userId, provider: "tiktok", providerUserId: conn.providerUserId,
      username: conn.username, accessToken: conn.accessToken, tokenExpiresAt: expiresAt,
      scopes: ["user.info.basic", "video.list"],
    },
    update: { providerUserId: conn.providerUserId, username: conn.username, accessToken: conn.accessToken, tokenExpiresAt: expiresAt },
  });
  return { userId };
}

async function getTiktok(userId: string) {
  const conn = await prisma.socialConnection.findUnique({ where: { userId_provider: { userId, provider: "tiktok" } } });
  if (!conn) throw notFound("TikTok is not connected");
  return conn;
}

export async function listTiktokVideos(userId: string) {
  const conn = await getTiktok(userId);
  const videos = await tt.listVideos(conn.accessToken);
  const imported = await prisma.importedMedia.findMany({
    where: { userId, provider: "tiktok", externalId: { in: videos.map((v) => v.externalId) } },
    select: { externalId: true, shotId: true },
  });
  const map = new Map(imported.map((i) => [i.externalId, i.shotId]));
  return {
    username: conn.username,
    videos: videos.map((v) => ({
      id: v.externalId, caption: v.caption, thumbnailUrl: v.coverUrl,
      permalink: v.shareUrl, duration: v.duration,
      imported: map.has(v.externalId), shotId: map.get(v.externalId) ?? null,
    })),
  };
}

/** Import selected TikToks as EMBED Shots (TikTok player; not re-hosted). */
export async function importTiktokVideos(userId: string, externalIds: string[]) {
  if (!externalIds.length) throw badRequest("Select at least one video to import");
  const conn = await getTiktok(userId);
  const videos = await tt.listVideos(conn.accessToken);
  const wanted = videos.filter((v) => externalIds.includes(v.externalId));
  if (!wanted.length) throw badRequest("None of the selected videos were found");

  const results: { externalId: string; shotId?: string; status: "imported" | "skipped" | "failed"; error?: string }[] = [];
  for (const v of wanted) {
    try {
      const existing = await prisma.importedMedia.findUnique({
        where: { userId_provider_externalId: { userId, provider: "tiktok", externalId: v.externalId } },
      });
      if (existing?.shotId) { results.push({ externalId: v.externalId, shotId: existing.shotId, status: "skipped" }); continue; }

      // No downloadable MP4 — store the embed. videoUrl holds the share URL so the
      // column stays non-null; embedUrl drives the TikTok-player rendering.
      const shot = await prisma.shot.create({
        data: {
          authorId: userId,
          videoUrl: v.shareUrl || v.embedUrl || "",
          embedUrl: v.embedUrl,
          sourceProvider: "tiktok",
          thumbnailUrl: v.coverUrl,
          caption: v.caption?.slice(0, 2200) ?? null,
          ...(v.duration ? { durationMs: Math.round(v.duration * 1000) } : {}),
        },
        select: { id: true },
      });
      await prisma.importedMedia.upsert({
        where: { userId_provider_externalId: { userId, provider: "tiktok", externalId: v.externalId } },
        create: { userId, provider: "tiktok", externalId: v.externalId, shotId: shot.id, permalink: v.shareUrl },
        update: { shotId: shot.id },
      });
      results.push({ externalId: v.externalId, shotId: shot.id, status: "imported" });
    } catch (e) {
      results.push({ externalId: v.externalId, status: "failed", error: e instanceof Error ? e.message : "import failed" });
    }
  }
  return {
    imported: results.filter((r) => r.status === "imported").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

export async function disconnectTiktok(userId: string) {
  await prisma.socialConnection.deleteMany({ where: { userId, provider: "tiktok" } });
  return { disconnected: true };
}
