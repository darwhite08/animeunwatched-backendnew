/**
 * OpenAPI spec tests — validates that the auto-generated spec covers the
 * real routes. If this drops below 100 paths something is broken in
 * lib/openapi-builder (regex parsing, router walk, etc.).
 */
import { describe, it, expect } from "vitest"
import { ROUTE_MOUNTS } from "../app/src/routes"
import { buildSpec, introspectRouters, docRoute } from "../app/src/lib/openapi-builder"
import { spec } from "../app/src/openapi"

describe("OpenAPI spec (auto-generated)", () => {
  it("has openapi version 3.1.0", () => {
    expect(spec.openapi).toBe("3.1.0")
  })

  it("has title, version, and a server", () => {
    expect(spec.info.title).toBeTruthy()
    expect(spec.info.version).toBeTruthy()
    expect(spec.servers?.length ?? 0).toBeGreaterThan(0)
  })

  it("documents bearer + step-up auth security schemes", () => {
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined()
    expect((spec.components?.securitySchemes?.bearerAuth as { type: string }).type).toBe("http")
    expect(spec.components?.securitySchemes?.stepUpToken).toBeDefined()
  })

  it("declares an Error schema with the { code, message } envelope", () => {
    const Err = spec.components?.schemas?.Error as { properties?: { error?: { properties?: { code?: unknown; message?: unknown } } } }
    expect(Err?.properties?.error?.properties?.code).toBeDefined()
    expect(Err?.properties?.error?.properties?.message).toBeDefined()
  })

  it("covers the main resource tags", () => {
    const tags = (spec.tags ?? []).map(t => t.name)
    expect(tags).toContain("auth")
    expect(tags).toContain("users")
    expect(tags).toContain("posts")
    expect(tags).toContain("anime")
    expect(tags).toContain("admin")
  })

  it("includes auth + posts paths under the introspected router", () => {
    const keys = Object.keys(spec.paths)
    expect(keys.some(k => k.startsWith("/auth/"))).toBe(true)
    expect(keys.some(k => k.startsWith("/posts"))).toBe(true)
    expect(keys.some(k => k.startsWith("/anime"))).toBe(true)
  })
})

describe("openapi-builder introspection", () => {
  it("finds more than 100 endpoints across the mount table", () => {
    const routes = introspectRouters(ROUTE_MOUNTS)
    expect(routes.length).toBeGreaterThan(100)
  })

  it("emits more than 80 distinct paths", () => {
    const s = buildSpec(ROUTE_MOUNTS)
    expect(Object.keys(s.paths).length).toBeGreaterThan(80)
  })

  it("converts Express :param → OpenAPI {param} consistently", () => {
    const s = buildSpec(ROUTE_MOUNTS)
    const paths = Object.keys(s.paths)
    expect(paths.some(p => /\{\w+\}/.test(p))).toBe(true)
    expect(paths.every(p => !/:\w+/.test(p))).toBe(true)
  })

  it("auto-infers path parameters from :name segments", () => {
    const s = buildSpec(ROUTE_MOUNTS)
    const userPath = Object.entries(s.paths).find(([p]) => p.endsWith("/users/{username}"))
    expect(userPath).toBeDefined()
    const params = userPath?.[1].get?.parameters ?? []
    expect(params.some(p => p.name === "username" && p.in === "path")).toBe(true)
  })

  it("docRoute() overrides apply to the next buildSpec output", () => {
    docRoute("get", "/users/:username", {
      summary: "Get a user's public profile",
      description: "Public; returns stats + recent posts.",
    })
    const s = buildSpec(ROUTE_MOUNTS)
    const op = s.paths["/users/{username}"]?.get
    expect(op?.summary).toBe("Get a user's public profile")
    expect(op?.description).toContain("Public")
  })
})
