/**
 * Uploads schema validation tests.
 */
import { describe, it, expect } from "vitest";
import {
  avatarUploadSchema,
  postImageUploadSchema,
  voiceUploadSchema,
} from "../app/src/modules/uploads/uploads.schema";

describe("avatarUploadSchema", () => {
  it("accepts image/jpeg", () => {
    expect(() => avatarUploadSchema.parse({ contentType: "image/jpeg" })).not.toThrow();
  });
  it("rejects non-image MIME", () => {
    expect(() => avatarUploadSchema.parse({ contentType: "audio/mp4" })).toThrow();
  });
});

describe("postImageUploadSchema", () => {
  it("accepts image/png with size under 10MB", () => {
    expect(() =>
      postImageUploadSchema.parse({ contentType: "image/png", size: 1024 * 1024 }),
    ).not.toThrow();
  });
  it("accepts without optional size", () => {
    expect(() => postImageUploadSchema.parse({ contentType: "image/webp" })).not.toThrow();
  });
  it("rejects size over 10MB", () => {
    expect(() =>
      postImageUploadSchema.parse({ contentType: "image/png", size: 10 * 1024 * 1024 + 1 }),
    ).toThrow();
  });
});

describe("voiceUploadSchema", () => {
  it.each([
    "audio/m4a",
    "audio/mp4",
    "audio/mpeg",
    "audio/aac",
    "audio/webm",
    "audio/ogg",
  ])("accepts %s", (contentType) => {
    expect(() => voiceUploadSchema.parse({ contentType })).not.toThrow();
  });

  it("accepts optional durationMs under 5 minutes", () => {
    expect(() =>
      voiceUploadSchema.parse({ contentType: "audio/m4a", durationMs: 4 * 60 * 1000 }),
    ).not.toThrow();
  });

  it("rejects durationMs over 5 minutes", () => {
    expect(() =>
      voiceUploadSchema.parse({ contentType: "audio/m4a", durationMs: 5 * 60 * 1000 + 1 }),
    ).toThrow();
  });

  it("rejects unsupported MIME (image/png)", () => {
    expect(() => voiceUploadSchema.parse({ contentType: "image/png" })).toThrow();
  });

  it("rejects missing contentType", () => {
    expect(() => voiceUploadSchema.parse({})).toThrow();
  });
});
