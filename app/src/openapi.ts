/**
 * Live OpenAPI 3.1 spec. Built by walking the actual Express router stack
 * so it stays in sync with the routes without us hand-maintaining a list.
 *
 * Per-route overrides (richer descriptions, request/response schemas) live
 * in modules that call `docRoute()` at import time — see lib/openapi-builder.
 */

import { ROUTE_MOUNTS } from "./routes"
import { buildSpec } from "./lib/openapi-builder"

export const spec = buildSpec(ROUTE_MOUNTS, {
  title:   "Kaiveron API",
  version: "1.0.0",
  description:
    "REST + WebSocket API for the Kaiveron anime social platform.\n\n" +
    "**Live spec** — paths below are introspected from the Express routers at " +
    "boot, so this stays in sync with what's actually deployed. Auth, error " +
    "envelopes, pagination, and rate-limit behaviour follow the conventions " +
    "documented in /docs/api-style-guide.md.\n\n" +
    "Browse interactively at https://api.kaiveron.com/docs.",
  baseUrl: "/api/v1",
})

export { docRoute } from "./lib/openapi-builder"
