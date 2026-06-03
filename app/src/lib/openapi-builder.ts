/**
 * Dependency-free OpenAPI 3.1 generator.
 *
 * Walks an Express Router's stack and emits a path entry per registered
 * route. For named middleware we infer auth/permission/step-up status by
 * inspecting the function name (requireAuth, optionalAuth,
 * requirePermission, requirePermissionWithStepUp). For request/response
 * shapes we emit a generic envelope by default; route owners can register
 * structured docs via `docRoute()` and they'll override the autogen entry.
 *
 * Why not swagger-ui-express or a schema-first lib? They lock you into
 * either heavy decorators or maintaining schemas twice. This generator
 * gets ~95% of the way there for free and lets us *add* precision per
 * route without rewriting controllers.
 */

import type { Router, IRouter } from "express"
import type { OpenAPIObject } from "./openapi-types"

type Method = "get" | "post" | "put" | "patch" | "delete" | "head" | "options"

const METHODS: Method[] = ["get", "post", "put", "patch", "delete", "head", "options"]

// ── Per-route docs registry ──────────────────────────────────────────────────

export interface RouteDoc {
  summary?:     string
  description?: string
  tags?:        string[]
  /** OpenAPI parameter objects (path/query/header). Path params are
   *  auto-inferred from `:name` segments unless this list overrides them. */
  parameters?:  Array<{ name: string; in: "path" | "query" | "header"; required?: boolean; description?: string; schema?: { type: string; enum?: unknown[] } }>
  requestBody?: { contentType?: string; schema?: Record<string, unknown>; description?: string }
  responses?:   Record<string, { description: string; schema?: Record<string, unknown> }>
}

const docs = new Map<string, RouteDoc>()

/** Attach human-authored documentation to a specific METHOD + path. The path
 *  must match what introspectRouter emits (Express style with `:name`). */
export function docRoute(method: Method, path: string, doc: RouteDoc): void {
  docs.set(`${method.toUpperCase()} ${path}`, doc)
}

// ── Router introspection ─────────────────────────────────────────────────────

interface ExpressLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ name: string; handle: unknown }>
  }
  handle?: IRouter & { stack?: ExpressLayer[] }
  name?: string
}

interface CollectedRoute { method: Method; path: string }

/**
 * Walk a single Router's stack of leaf routes (no sub-router descent).
 * Express 5 dropped the `regexp` we used to use to recover sub-router
 * mount prefixes, so we now require callers to register mounts explicitly
 * via the `mounts` argument to `introspectRouters`.
 */
function leavesOf(router: IRouter): CollectedRoute[] {
  const out: CollectedRoute[] = []
  const stack = (router as unknown as { stack?: ExpressLayer[] }).stack ?? []
  for (const layer of stack) {
    if (layer.route) {
      const path = layer.route.path
      for (const m of METHODS) {
        if (layer.route.methods[m]) out.push({ method: m, path })
      }
    }
  }
  return out
}

/**
 * Collect every route across a set of `(mountPath, router)` pairs.
 * Mounts mirror `app.use("/auth", authRouter)` — pass the same prefix.
 */
export function introspectRouters(
  mounts: ReadonlyArray<readonly [prefix: string, router: IRouter]>,
): CollectedRoute[] {
  const out: CollectedRoute[] = []
  for (const [prefix, router] of mounts) {
    for (const leaf of leavesOf(router)) {
      out.push({ method: leaf.method, path: prefix + leaf.path })
    }
  }
  return out
}

/**
 * Legacy convenience for a single root router — when you ALSO pass an
 * explicit prefix it walks just that router's leaves under the prefix.
 * Without a prefix it walks root leaves only (no sub-router descent).
 */
export function introspectRouter(router: IRouter, prefix = ""): CollectedRoute[] {
  return leavesOf(router).map(({ method, path }) => ({ method, path: prefix + path }))
}

// ── Auto-tagging from path prefix ────────────────────────────────────────────

function inferTag(path: string): string {
  // /api/v1/users/... → "users"; /admin/... → "admin"
  const seg = path.replace(/^\/(api\/v1\/)?/, "").split("/")[0]
  return seg || "root"
}

// ── Path-param inference ─────────────────────────────────────────────────────

function inferPathParams(path: string): RouteDoc["parameters"] {
  const params: NonNullable<RouteDoc["parameters"]> = []
  const re = /:([A-Za-z_][\w]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    params.push({ name: m[1], in: "path", required: true, schema: { type: "string" } })
  }
  return params.length > 0 ? params : undefined
}

// ── Spec assembly ────────────────────────────────────────────────────────────

const DEFAULT_RESPONSES = {
  "200": { description: "Success" },
  "400": { description: "Bad request (validation error)" },
  "401": { description: "Unauthorized" },
  "403": { description: "Forbidden" },
  "404": { description: "Not found" },
  "429": { description: "Rate limited" },
  "500": { description: "Internal server error" },
}

export function buildSpec(
  mountsOrRouter: ReadonlyArray<readonly [string, IRouter]> | IRouter,
  opts: { title?: string; version?: string; description?: string; baseUrl?: string } = {},
): OpenAPIObject {
  const routes = Array.isArray(mountsOrRouter)
    ? introspectRouters(mountsOrRouter as ReadonlyArray<readonly [string, IRouter]>)
    : introspectRouter(mountsOrRouter as IRouter)
  const paths: OpenAPIObject["paths"] = {}

  for (const { method, path } of routes) {
    // Convert Express :param to OpenAPI {param}
    const openapiPath = path.replace(/:([A-Za-z_]\w*)/g, "{$1}")
    const docKey = `${method.toUpperCase()} ${path}`
    const override = docs.get(docKey)

    if (!paths[openapiPath]) paths[openapiPath] = {}

    paths[openapiPath][method] = {
      summary:    override?.summary    ?? `${method.toUpperCase()} ${path}`,
      description: override?.description,
      tags:       override?.tags       ?? [inferTag(path)],
      parameters: override?.parameters ?? inferPathParams(path),
      ...(override?.requestBody && {
        requestBody: {
          required: true,
          content:  { [override.requestBody.contentType ?? "application/json"]: { schema: override.requestBody.schema ?? { type: "object" } } },
        },
      }),
      responses: override?.responses ?? DEFAULT_RESPONSES,
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title:       opts.title       ?? "Kaiveron API",
      version:     opts.version     ?? "1.0.0",
      description: opts.description ?? "REST + WebSocket API for the Kaiveron anime social platform. See /docs for interactive exploration.",
      contact:     { name: "Kaiveron API", url: "https://kaiveron.com" },
    },
    servers: [{ url: opts.baseUrl ?? "/api/v1", description: "Production" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Access token from POST /auth/login" },
        stepUpToken: { type: "apiKey", in: "header", name: "X-StepUp-Token", description: "Short-lived token from POST /admin/stepup. Required for high-risk actions." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code:    { type: "string", description: "UPPER_SNAKE machine-readable code" },
                message: { type: "string", description: "Human-readable error message" },
              },
            },
          },
        },
        PaginationMeta: {
          type: "object",
          properties: {
            total: { type: "integer" }, page: { type: "integer" },
            limit: { type: "integer" }, pages: { type: "integer" },
          },
        },
        CursorMeta: {
          type: "object",
          properties: {
            nextCursor: { type: ["string", "null"] },
          },
        },
      },
    },
    tags: Array.from(new Set(routes.map(r => inferTag(r.path)))).sort().map(t => ({ name: t })),
  }
}
