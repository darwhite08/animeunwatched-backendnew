import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { notFound, badRequest } from "../../lib/errors";
import { uploadImageBuffer } from "../../lib/storage";
import * as ig from "../../lib/social/instagram";
import * as shots from "../shots/shots.service";

// ─── OAuth state (stateless, signed) ────────────────────────────────────────
// The IG callback has no auth header, so we carry the userId in a short-lived
// signed state param and verify it on return — no server-side session store.

function signState(userId: string): string {
  return jwt.sign({ userId, p: "instagram" }, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
}
function verifyState(state: string): string {
  try {
    const d = jwt.verify(state, env.JWT_ACCESS_SECRET) as { userId: string; p: string };
    if (d.p !== "instagram" || !d.userId) throw new Error("bad state");
    return d.userId;
  } catch {
    throw badRequest("Invalid or expired connect link");
  }
}

// ─── Connections ────────────────────────────────────────────────────────────

export function instagramAvailable(): boolean {
  return ig.isConfigured();
}

export async function listConnections(userId: string) {
  const rows = await prisma.socialConnection.findMany({
    where: { userId },
    select: { provider: true, username: true, providerUserId: true, tokenExpiresAt: true, createdAt: true },
  });
  return {
    instagramAvailable: ig.isConfigured(),
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
  return { url: ig.getAuthUrl(signState(userId)) };
}

/** Handle the OAuth redirect: verify state, exchange code, store the token. */
export async function handleInstagramCallback(code: string, state: string): Promise<{ userId: string }> {
  const userId = verifyState(state);
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
