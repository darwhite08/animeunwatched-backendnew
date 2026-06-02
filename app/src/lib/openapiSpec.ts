import type { Application, RequestHandler } from "express"

/**
 * Auto-generated OpenAPI 3.1 spec built by introspecting the Express
 * router stack. We don't reach JSON-Schema-level type info per route
 * (TypeScript is erased) but we DO get:
 *   - the verb + path
 *   - whether the route requires auth (presence of `requireAuth` in the
 *     handler chain — we check function names)
 *   - whether it requires admin
 *   - the permission gate (parsed from `requirePermission(resource, action)`)
 *
 * The result is a real, navigable spec — useful for partners exploring
 * the admin surface + for ops to verify "is this endpoint actually
 * gated by step-up?" at a glance.
 */

interface RouteInfo {
  method:   string
  path:     string
  requiresAuth:  boolean
  requiresAdmin: boolean
  permission?:   { resource: string; action: string }
  stepUp:        boolean
}

function isHandlerCalled(handler: RequestHandler, name: string): boolean {
  // Simple heuristic — works because middleware functions tend to keep their declared name.
  return handler.name === name || (handler as { _name?: string })._name === name
}

function inspectStack(app: Application): RouteInfo[] {
  interface ExpressLayer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler; name?: string }> }; name?: string; handle?: Application; regexp?: { source: string } }
  type ExpressApp = Application & { _router?: { stack: ExpressLayer[] }; router?: { stack: ExpressLayer[] } }
  const out: RouteInfo[] = []

  function walk(stack: ExpressLayer[] | undefined, basePath: string): void {
    if (!stack) return
    for (const layer of stack) {
      if (layer.route) {
        const r = layer.route
        const methods = Object.keys(r.methods).filter(m => r.methods[m])
        for (const method of methods) {
          const stackNames = r.stack.map(s => s.handle.name)
          const info: RouteInfo = {
            method:        method.toUpperCase(),
            path:          basePath + r.path,
            requiresAuth:  stackNames.includes("requireAuth"),
            requiresAdmin: stackNames.includes("requireAdmin"),
            stepUp:        r.stack.some(s => /WithStepUp/.test(s.handle.toString().slice(0, 200))),
          }
          // Try to recover the permission tuple from the handler's source
          for (const s of r.stack) {
            const src = s.handle.toString()
            const m = src.match(/requirePermission(?:WithStepUp)?\("([^"]+)",\s*"([^"]+)"\)/)
            if (m) { info.permission = { resource: m[1], action: m[2] }; break }
          }
          out.push(info)
        }
      } else if (layer.handle && (layer.name === "router" || (layer.handle as ExpressApp)._router || (layer.handle as ExpressApp).router)) {
        // Sub-router. Derive its mount prefix from the regexp.
        const prefix = layer.regexp ? layerPrefix(layer.regexp.source) : ""
        const subRouter = (layer.handle as ExpressApp & { stack?: ExpressLayer[] })
        const subStack  = subRouter._router?.stack ?? subRouter.router?.stack ?? (subRouter as unknown as { stack: ExpressLayer[] }).stack
        walk(subStack, basePath + prefix)
      }
    }
  }

  const root = app as ExpressApp
  walk(root._router?.stack ?? root.router?.stack, "")
  return out
}

// Recover "/foo" from regex like "^\\/foo\\/?(?=\\/|$)"
function layerPrefix(src: string): string {
  const cleaned = src
    .replace(/^\^/, "")
    .replace(/\\\//g, "/")
    .replace(/\?\(\?=.+\)\$?/, "")
    .replace(/\?\$$/, "")
    .replace(/\$$/, "")
  return cleaned
}

export function buildOpenApiSpec(app: Application): Record<string, unknown> {
  const routes = inspectStack(app)
  // Group routes by path into OpenAPI paths object
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of routes) {
    const oasPath = r.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}")
    paths[oasPath] = paths[oasPath] ?? {}
    const params = Array.from(r.path.matchAll(/:([a-zA-Z0-9_]+)/g)).map(m => ({
      name:     m[1],
      in:       "path",
      required: true,
      schema:   { type: "string" },
    }))
    const tags: string[] = []
    const seg = r.path.split("/").filter(Boolean)
    if (seg[2]) tags.push(seg[2])      // e.g. /api/v1/admin → "admin"
    const security =
      r.requiresAdmin ? [{ bearerAuth: ["admin"] }] :
      r.requiresAuth  ? [{ bearerAuth: [] }] : undefined
    paths[oasPath][r.method.toLowerCase()] = {
      tags,
      summary: `${r.method} ${oasPath}`,
      ...(security ? { security } : {}),
      ...(r.permission ? { "x-permission": `${r.permission.resource}:${r.permission.action}` } : {}),
      ...(r.stepUp     ? { "x-step-up": true } : {}),
      parameters: params,
      responses: {
        "200": { description: "OK" },
        "400": { description: "Validation error" },
        ...(r.requiresAuth  ? { "401": { description: "Unauthorized" } } : {}),
        ...(r.requiresAdmin ? { "403": { description: "Admin role required" } } : {}),
      },
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title:   "Kaiveron API",
      version: "1.0.0",
      description: "Auto-generated from the live Express router. Routes flagged with `x-permission` require the listed admin permission; `x-step-up` routes additionally require a fresh step-up token in `X-StepUp-Token`.",
    },
    servers: [
      { url: "https://api.kaiveron.com", description: "Production" },
      { url: "http://localhost:4000",    description: "Local dev" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    paths,
  }
}
