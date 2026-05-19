/**
 * OpenAPI spec tests — validates the spec structure.
 */
import { describe, it, expect } from "vitest";
import { spec } from "../app/src/openapi";

describe("OpenAPI spec", () => {
  it("has openapi version 3.1.0", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  it("has title and version in info", () => {
    expect(spec.info.title).toBeDefined();
    expect(spec.info.version).toBeDefined();
    expect(typeof spec.info.title).toBe("string");
    expect(typeof spec.info.version).toBe("string");
  });

  it("has at least one server", () => {
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers.length).toBeGreaterThan(0);
  });

  it("has tags array", () => {
    expect(Array.isArray(spec.tags)).toBe(true);
    expect(spec.tags.length).toBeGreaterThan(0);
  });

  it("has paths object", () => {
    expect(typeof spec.paths).toBe("object");
    expect(spec.paths).not.toBeNull();
  });

  it("has at least auth and anime paths", () => {
    const pathKeys = Object.keys(spec.paths);
    expect(pathKeys.some(p => p.includes("auth"))).toBe(true);
    expect(pathKeys.some(p => p.includes("anime"))).toBe(true);
  });

  it("has bearerAuth security scheme in components", () => {
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe("http");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("health check endpoint exists", () => {
    expect(spec.paths["/health"]).toBeDefined();
  });

  it("register endpoint has 201 response", () => {
    const registerPath = spec.paths["/auth/register"];
    expect(registerPath).toBeDefined();
    expect(registerPath.post?.responses?.["201"]).toBeDefined();
  });

  it("login endpoint exists", () => {
    expect(spec.paths["/auth/login"]).toBeDefined();
  });
});
