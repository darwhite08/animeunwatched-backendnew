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
  return {
    instagramAvailable: ig.isConfigured(),
    tiktokAvailable: tt.isConfigured(),
    connections: rows.map((r) => ({
      provider: r.provider,
      username: r.username,
      connectedAt: r.createdAt.toISOString(),
      expiresAt: r.tokenExpiresAt?.toISOString() ?? null,
    })),
  };
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

/** List the creator's IG reels, flagged with whether each is already imported. */
export async function listInstagramReels(userId: string) {
  const conn = await getInstagram(userId);
  const reels = await ig.listReels(conn.accessToken);
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
  const reels = await ig.listReels(conn.accessToken, 50);
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
