import crypto from "node:crypto";
import { prisma } from "../../config/prisma";
import { notFound, unauth, badRequest } from "../../lib/errors";
import { sanitizeBlogHtml } from "../../lib/sanitizeBlogHtml";
import { getByMalIds } from "../anime/anime.service";
import type { NormalizedSource, SubmitDraftDto } from "./integrations.schema";

// ─── Key format + hashing ────────────────────────────────────────────────────
// Raw key: kv_live_<48 hex>. Shown ONCE at creation. Only the SHA-256 hash is
// ever persisted; the display prefix (kv_live_a1b2…) is safe to store & show.

const KEY_ENV = "live"; // reserved for a future kv_test_ sandbox variant
const RAW_BYTES = 24;

function generateRawKey(): string {
  return `kv_${KEY_ENV}_${crypto.randomBytes(RAW_BYTES).toString("hex")}`;
}

function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function prefixOf(raw: string): string {
  // kv_live_ (8) + first 4 of the secret, then an ellipsis.
  return `${raw.slice(0, 12)}…`;
}

// ─── Public shape (never leaks keyHash) ──────────────────────────────────────

type KeyRow = {
  id: string; label: string; keyPrefix: string; revoked: boolean;
  draftCount: number; lastUsedAt: Date | null; createdAt: Date;
};

function publicKey(k: KeyRow) {
  return {
    id: k.id,
    label: k.label,
    keyPrefix: k.keyPrefix,
    revoked: k.revoked,
    draftCount: k.draftCount,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

const keySelect = {
  id: true, label: true, keyPrefix: true, revoked: true,
  draftCount: true, lastUsedAt: true, createdAt: true,
} as const;

// ─── Key management (session-authed creator) ─────────────────────────────────

export async function createKey(ownerId: string, label: string) {
  const raw = generateRawKey();
  const key = await prisma.integrationKey.create({
    data: { ownerId, label, keyHash: hashKey(raw), keyPrefix: prefixOf(raw) },
    select: keySelect,
  });
  // rawKey is returned to the caller ONCE and never stored anywhere.
  return { rawKey: raw, key: publicKey(key) };
}

export async function listKeys(ownerId: string) {
  // Revoked keys are dead — hide them so the list only shows active keys (a
  // revoked row lingering as "REVOKED" reads like an error). The row stays in
  // the DB for attribution/idempotency; the intake rejects it regardless.
  const keys = await prisma.integrationKey.findMany({
    where: { ownerId, revoked: false },
    orderBy: { createdAt: "desc" },
    select: keySelect,
  });
  return { keys: keys.map(publicKey) };
}

export async function revokeKey(ownerId: string, id: string) {
  const key = await prisma.integrationKey.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!key) throw notFound("Key not found");
  const updated = await prisma.integrationKey.update({
    where: { id }, data: { revoked: true }, select: keySelect,
  });
  return { key: publicKey(updated) };
}

// ─── Draft intake core ───────────────────────────────────────────────────────

function toSlug(title: string): string {
  const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = crypto.randomBytes(4).toString("hex").slice(0, 6);
  return `${(base || "draft").slice(0, 80)}-${suffix}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the stored HTML body: sanitize the incoming HTML, then append a
 *  "Sources" section (if any) so it renders in the existing editor. */
function buildBody(bodyHtml: string, sources?: NormalizedSource[]): string {
  const clean = sanitizeBlogHtml(bodyHtml);
  if (!sources?.length) return clean;
  const items = sources
    .map((s) => {
      const url = escapeHtml(s.url);
      const label = escapeHtml(s.label?.trim() || s.url);
      return `<li><a href="${url}" rel="noopener noreferrer" target="_blank">${label}</a></li>`;
    })
    .join("");
  return `${clean}<hr><h3>Sources</h3><ul>${items}</ul>`;
}

async function resolveAnimeTitle(malId: number | null | undefined): Promise<string | null> {
  if (!malId) return null;
  try {
    const [a] = await getByMalIds([malId]);
    return (a && ((a as { titleEnglish?: string | null; title?: string }).titleEnglish || (a as { title?: string }).title)) || null;
  } catch {
    return null;
  }
}

/**
 * Create (or idempotently return) a PENDING_REVIEW blog on behalf of the key's
 * owner. The channel can NEVER publish — status is hard-forced regardless of
 * input. Idempotency is scoped per key: the same Idempotency-Key never creates a
 * second draft. Returns the draft id + status and whether it was a duplicate.
 */
async function createDraft(
  key: { id: string; ownerId: string },
  idempotencyHeader: string,
  dto: SubmitDraftDto,
): Promise<{ id: string; status: string; slug: string; deduped: boolean }> {
  const scopedIdem = `${key.id}:${idempotencyHeader}`;

  const existing = await prisma.blog.findUnique({
    where: { idempotencyKey: scopedIdem },
    select: { id: true, status: true, slug: true },
  });
  if (existing) return { ...existing, deduped: true };

  const animeMalId = dto.animeMalId ?? null;
  const animeTitle = await resolveAnimeTitle(animeMalId);
  // sources arrive as plain URL strings or { url, label } — normalize to objects.
  const sources: NormalizedSource[] | undefined = dto.sources?.map((s) =>
    typeof s === "string" ? { url: s } : s,
  );
  const body = buildBody(dto.body, sources);

  try {
    const blog = await prisma.blog.create({
      data: {
        authorId: key.ownerId,
        title: dto.title,
        body,
        slug: toSlug(dto.title),
        status: "PENDING_REVIEW", // hard-forced — a key can never publish.
        category: dto.category ?? null,
        hasSpoilers: dto.noSpoilers === undefined ? false : !dto.noSpoilers,
        animeMalId,
        animeTitle: animeMalId ? animeTitle : null,
        sourceKeyId: key.id,
        idempotencyKey: scopedIdem,
      },
      select: { id: true, status: true, slug: true },
    });
    await prisma.integrationKey.update({
      where: { id: key.id },
      data: { draftCount: { increment: 1 }, lastUsedAt: new Date() },
    });
    return { ...blog, deduped: false };
  } catch (e) {
    // Concurrent submit with the same Idempotency-Key → unique violation. Re-read
    // and return the winner so the intake stays idempotent under races.
    if ((e as { code?: string }).code === "P2002") {
      const won = await prisma.blog.findUnique({
        where: { idempotencyKey: scopedIdem },
        select: { id: true, status: true, slug: true },
      });
      if (won) return { ...won, deduped: true };
    }
    throw e;
  }
}

// ─── Intake endpoint (external service, Bearer key) ──────────────────────────

export async function submitDraft(rawKey: string | undefined, idempotencyHeader: string | undefined, dto: SubmitDraftDto) {
  if (!rawKey) throw unauth("Missing API key");
  if (!idempotencyHeader?.trim()) throw badRequest("Idempotency-Key header is required", "IDEMPOTENCY_REQUIRED");

  const key = await prisma.integrationKey.findUnique({
    where: { keyHash: hashKey(rawKey) },
    select: { id: true, ownerId: true, revoked: true },
  });
  if (!key || key.revoked) throw unauth("Invalid or revoked API key");

  return createDraft({ id: key.id, ownerId: key.ownerId }, idempotencyHeader.trim(), dto);
}

// ─── Test: fire a sample draft through the same path (session-authed) ────────

export async function testKey(ownerId: string, id: string) {
  const key = await prisma.integrationKey.findFirst({
    where: { id, ownerId },
    select: { id: true, ownerId: true, revoked: true },
  });
  if (!key) throw notFound("Key not found");
  if (key.revoked) throw badRequest("This key is revoked", "KEY_REVOKED");

  const sample: SubmitDraftDto = {
    title: "Test draft from your Blog Draft Channel",
    body:
      "<p>👋 This is a <strong>sample draft</strong> posted through your Blog Draft Channel to prove the wiring end to end. " +
      "Open it in the editor, then delete it or publish it.</p>" +
      "<p>Images and YouTube embeds round-trip too:</p>" +
      '<div data-youtube-video><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="640" height="360" allowfullscreen="allowfullscreen" frameborder="0"></iframe></div>',
    category: "NEWS",
    noSpoilers: true,
    animeMalId: null,
    sources: [{ url: "https://kaiveron.com", label: "Kaiveron" }],
  };
  // Unique idempotency key per test press so each test creates a fresh draft.
  const draft = await createDraft({ id: key.id, ownerId: key.ownerId }, `test-${crypto.randomUUID()}`, sample);
  return draft;
}
