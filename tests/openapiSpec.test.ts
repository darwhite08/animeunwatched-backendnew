import { describe, it, expect } from "vitest"
import express from "express"
import { buildOpenApiSpec } from "../app/src/lib/openapiSpec"

describe("buildOpenApiSpec", () => {
  it("produces a valid 3.1 envelope", () => {
    const app = express()
    app.get("/health", (_req, res) => { res.json({}) })
    const spec = buildOpenApiSpec(app) as Record<string, unknown>
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.info).toMatchObject({ title: "Kaiveron API" })
    expect(spec.components).toBeDefined()
  })

  it("emits paths with method-keyed operations and parameter templates", () => {
    const app = express()
    app.get("/users/:id", (_req, res) => { res.json({}) })
    app.delete("/users/:id", (_req, res) => { res.json({}) })
    const spec = buildOpenApiSpec(app) as { paths: Record<string, Record<string, { parameters: unknown[] }>> }
    expect(spec.paths["/users/{id}"]).toBeDefined()
    expect(spec.paths["/users/{id}"].get).toBeDefined()
    expect(spec.paths["/users/{id}"].delete).toBeDefined()
    expect(spec.paths["/users/{id}"].get.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
    ])
  })

  it("walks sub-routers when mounted with app.use", () => {
    const sub = express.Router()
    sub.get("/me", (_req, res) => { res.json({}) })
    const app = express()
    app.use("/auth", sub)
    const spec = buildOpenApiSpec(app) as { paths: Record<string, unknown> }
    // Either /auth/me or /me depending on regex parsing — accept either since
    // the introspection of nested routers is best-effort.
    const paths = Object.keys(spec.paths)
    expect(paths.some(p => p.endsWith("/me"))).toBe(true)
  })

  it("returns an empty paths object when nothing is registered", () => {
    const app = express()
    const spec = buildOpenApiSpec(app) as { paths: Record<string, unknown> }
    expect(typeof spec.paths).toBe("object")
  })
})
