import sharp from "sharp";
import { encode as blurhashEncode } from "blurhash";
import { uploadImageBuffer } from "../../lib/storage";
import { badReq } from "../../lib/errors";

// Magic-byte sniffing for the small allowlist — never trust the client mimetype
// or extension (security §5). Returns a normalized kind or null if unrecognized.
function sniff(buf: Buffer): { kind: "image" | "voice"; mime: string; ext: string } | null {
  const b = buf;
  const startsWith = (sig: number[], off = 0) => sig.every((x, i) => b[off + i] === x);
  // Images
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png", ext: "png" };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif", ext: "gif" };
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && b.slice(8, 12).toString("ascii") === "WEBP")
    return { kind: "image", mime: "image/webp", ext: "webp" };
  // Audio (voice notes)
  // OggS
  if (startsWith([0x4f, 0x67, 0x67, 0x53])) return { kind: "voice", mime: "audio/ogg", ext: "ogg" };
  // EBML (webm/mka) — also used for audio/webm
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return { kind: "voice", mime: "audio/webm", ext: "webm" };
  // ISO-BMFF (m4a/mp4 audio): ....ftyp
  if (b.slice(4, 8).toString("ascii") === "ftyp") return { kind: "voice", mime: "audio/mp4", ext: "m4a" };
  // MP3: ID3 or frame sync
  if (startsWith([0x49, 0x44, 0x33])) return { kind: "voice", mime: "audio/mpeg", ext: "mp3" };
  return null;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;

export type DmMediaResult = {
  mediaUrl: string;
  mediaMime: string;
  mediaSizeBytes: number;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaBlurhash?: string;
  mediaDurationS?: number;
};

/**
 * Process + store a DM media upload. Images: validate magic bytes, strip EXIF,
 * resize ≤2048px, re-encode webp q80, compute dimensions + blurhash. Voice:
 * validate magic bytes + size, store as-is. Duration comes from the client
 * (sanity-capped). The returned shape attaches to a `dm:send` media payload.
 */
export async function processDmMedia(opts: {
  userId: string;
  buffer: Buffer;
  durationS?: number;
}): Promise<DmMediaResult> {
  const sniffed = sniff(opts.buffer);
  if (!sniffed) throw badReq("Unsupported file type");

  if (sniffed.kind === "image") {
    if (opts.buffer.length > MAX_IMAGE_BYTES) throw badReq("Image too large — max 10MB");
    // Re-encode strips EXIF by default (no withMetadata()). Resize keeps aspect.
    const pipeline = sharp(opts.buffer, { failOn: "error" }).rotate().resize({
      width: 2048, height: 2048, fit: "inside", withoutEnlargement: true,
    });
    const webp = await pipeline.webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const { data, info } = webp;
    // blurhash from a tiny raw downscale
    const raw = await sharp(data).raw().ensureAlpha().resize(32, 32, { fit: "inside" }).toBuffer({ resolveWithObject: true });
    const hash = blurhashEncode(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height, 4, 3);

    const { publicUrl } = await uploadImageBuffer({
      userId: opts.userId, scope: "dm", contentType: "image/webp", ext: "webp", body: data,
    });
    return {
      mediaUrl: publicUrl,
      mediaMime: "image/webp",
      mediaSizeBytes: info.size,
      mediaWidth: info.width,
      mediaHeight: info.height,
      mediaBlurhash: hash,
    };
  }

  // voice
  if (opts.buffer.length > MAX_VOICE_BYTES) throw badReq("Voice note too large — max 5MB");
  const durationS = opts.durationS != null ? Math.min(180, Math.max(1, Math.round(opts.durationS))) : undefined;
  const { publicUrl } = await uploadImageBuffer({
    userId: opts.userId, scope: "dm", contentType: sniffed.mime, ext: sniffed.ext, body: opts.buffer,
  });
  return {
    mediaUrl: publicUrl,
    mediaMime: sniffed.mime,
    mediaSizeBytes: opts.buffer.length,
    ...(durationS ? { mediaDurationS: durationS } : {}),
  };
}
