/**
 * DM media pipeline (spec §5, security §5): magic-byte validation, EXIF strip
 * via re-encode, blurhash, our-bucket URL. Uses sharp to synthesize a real PNG.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

vi.mock("../app/src/lib/storage", () => ({
  uploadImageBuffer: vi.fn().mockResolvedValue({ publicUrl: "https://media.kaiveron.com/dm/u1/x.webp", key: "dm/u1/x.webp" }),
}));

beforeEach(() => vi.clearAllMocks());

describe("processDmMedia", () => {
  it("accepts a real image, re-encodes to webp, returns dimensions + blurhash", async () => {
    const { processDmMedia } = await import("../app/src/modules/uploads/dmMedia.service");
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    const res = await processDmMedia({ userId: "u1", buffer: png });
    expect(res.mediaMime).toBe("image/webp");
    expect(res.mediaWidth).toBe(64);
    expect(res.mediaHeight).toBe(48);
    expect(typeof res.mediaBlurhash).toBe("string");
    expect(res.mediaUrl.startsWith("https://media.kaiveron.com/")).toBe(true);
  });

  it("rejects unrecognized / spoofed bytes (magic-byte check)", async () => {
    const { processDmMedia } = await import("../app/src/modules/uploads/dmMedia.service");
    const junk = Buffer.from("this is not an image or audio file at all", "utf8");
    await expect(processDmMedia({ userId: "u1", buffer: junk })).rejects.toThrow("Unsupported file type");
  });

  it("accepts an Ogg voice note and caps duration at 180s", async () => {
    const { processDmMedia } = await import("../app/src/modules/uploads/dmMedia.service");
    const ogg = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53]), Buffer.alloc(64)]); // "OggS" + padding
    const res = await processDmMedia({ userId: "u1", buffer: ogg, durationS: 9999 });
    expect(res.mediaMime).toBe("audio/ogg");
    expect(res.mediaDurationS).toBe(180);
  });
});
