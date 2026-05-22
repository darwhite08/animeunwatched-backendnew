/**
 * Uploads service tests — verify scope + ext mapping is correct for each
 * presign* helper. The underlying R2 presign is mocked so no AWS creds are needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const presignImageUploadMock = vi.fn();

vi.mock("../app/src/lib/storage", () => ({
  presignImageUpload: (...args: unknown[]) => presignImageUploadMock(...args),
}));

beforeEach(() => {
  presignImageUploadMock.mockReset();
  presignImageUploadMock.mockResolvedValue({
    uploadUrl: "https://r2.example/upload",
    publicUrl: "https://cdn.example/key",
    key: "fake-key",
    expiresIn: 300,
    contentType: "mocked",
  });
});

describe("uploads.service.presignAvatar", () => {
  it("calls storage with scope=avatar and image/jpeg → jpg ext", async () => {
    const svc = await import("../app/src/modules/uploads/uploads.service");
    await svc.presignAvatar({ userId: "u1", contentType: "image/jpeg" });
    expect(presignImageUploadMock).toHaveBeenCalledWith({
      userId: "u1",
      scope: "avatar",
      contentType: "image/jpeg",
      ext: "jpg",
    });
  });
});

describe("uploads.service.presignPostImage", () => {
  it("calls storage with scope=post and image/webp → webp ext", async () => {
    const svc = await import("../app/src/modules/uploads/uploads.service");
    await svc.presignPostImage({ userId: "u1", contentType: "image/webp" });
    expect(presignImageUploadMock).toHaveBeenCalledWith({
      userId: "u1",
      scope: "post",
      contentType: "image/webp",
      ext: "webp",
    });
  });
});

describe("uploads.service.presignVoiceMessage", () => {
  it.each([
    ["audio/m4a", "m4a"],
    ["audio/mp4", "m4a"],
    ["audio/mpeg", "mp3"],
    ["audio/aac", "aac"],
    ["audio/webm", "webm"],
    ["audio/ogg", "ogg"],
  ])("maps %s → .%s with scope=voice", async (contentType, ext) => {
    const svc = await import("../app/src/modules/uploads/uploads.service");
    await svc.presignVoiceMessage({ userId: "u-voice", contentType });
    expect(presignImageUploadMock).toHaveBeenCalledWith({
      userId: "u-voice",
      scope: "voice",
      contentType,
      ext,
    });
  });

  it("returns the upload intent from storage unchanged", async () => {
    const svc = await import("../app/src/modules/uploads/uploads.service");
    const result = await svc.presignVoiceMessage({
      userId: "u1",
      contentType: "audio/m4a",
    });
    expect(result).toMatchObject({
      uploadUrl: "https://r2.example/upload",
      publicUrl: "https://cdn.example/key",
      key: "fake-key",
      expiresIn: 300,
    });
  });
});
