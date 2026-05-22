/**
 * Version service tests — env fallback + shape of returned VersionInfo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getVersion } from "../app/src/modules/version/version.service";

const originalSha = process.env.RENDER_GIT_COMMIT;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalSha === undefined) delete process.env.RENDER_GIT_COMMIT;
  else process.env.RENDER_GIT_COMMIT = originalSha;
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});

describe("getVersion", () => {
  beforeEach(() => {
    delete process.env.RENDER_GIT_COMMIT;
  });

  it("falls back to 'dev' when RENDER_GIT_COMMIT is unset", () => {
    const v = getVersion();
    expect(v.sha).toBe("dev");
    expect(v.shortSha).toBe("dev");
  });

  it("returns full + short SHA when RENDER_GIT_COMMIT is set", () => {
    process.env.RENDER_GIT_COMMIT = "abc1234567890def1234567890abcdef12345678";
    const v = getVersion();
    expect(v.sha).toBe("abc1234567890def1234567890abcdef12345678");
    expect(v.shortSha).toBe("abc1234");
  });

  it("includes service name", () => {
    expect(getVersion().service).toBe("kaiveron-backend");
  });

  it("includes a parseable ISO timestamp", () => {
    const v = getVersion();
    expect(() => new Date(v.ts).toISOString()).not.toThrow();
    expect(Number.isFinite(Date.parse(v.ts))).toBe(true);
  });

  it("reports NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    expect(getVersion().env).toBe("production");
  });
});
