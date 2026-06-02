/**
 * SCIM 2.0 helpers — RFC 7644 (protocol) + RFC 7643 (schema).
 *
 * Scope kept tight on purpose:
 *   - User resource only (Groups in a later batch)
 *   - Filter subset: eq, sw, co operators on userName + externalId
 *   - PATCH ops: replace/add/remove on `active` and standard attrs
 *
 * Anything beyond this surface raises 501 Not Implemented — that's spec
 * behavior and is how Okta/Azure auto-degrade their feature usage.
 */

export interface ScimUser {
  schemas:      string[]
  id:           string
  externalId:   string | null
  userName:     string
  displayName:  string
  active:       boolean
  emails:       Array<{ value: string; primary?: boolean; type?: string }>
  meta:         {
    resourceType: "User"
    created:      string
    lastModified: string
    location:     string
  }
}

export interface KaiveronUserShape {
  id:          string
  email:       string
  username:    string
  displayName: string
  isBanned:    boolean
  createdAt:   Date
  updatedAt:   Date
}

const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"

export function userToScim(u: KaiveronUserShape, externalId: string | null, baseUrl: string): ScimUser {
  return {
    schemas:    [USER_CORE_SCHEMA],
    id:         u.id,
    externalId,
    userName:   u.username,
    displayName: u.displayName,
    active:     !u.isBanned,
    emails:     u.email ? [{ value: u.email, primary: true, type: "work" }] : [],
    meta: {
      resourceType: "User",
      created:      u.createdAt.toISOString(),
      lastModified: u.updatedAt.toISOString(),
      location:     `${baseUrl}/Users/${u.id}`,
    },
  }
}

/** SCIM ListResponse envelope (RFC 7644 §3.4.2). */
export function listResponse(resources: ScimUser[], totalResults: number, startIndex: number, itemsPerPage: number): Record<string, unknown> {
  return {
    schemas:      ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources:    resources,
  }
}

/** SCIM Error response (RFC 7644 §3.12). */
export function scimError(status: number, detail: string, scimType?: string): { body: Record<string, unknown>; status: number } {
  return {
    status,
    body: {
      schemas:  ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail,
      status:   String(status),
      ...(scimType ? { scimType } : {}),
    },
  }
}

/**
 * Minimal SCIM filter parser. Supports:
 *   userName  eq  "alice"
 *   userName  sw  "al"
 *   userName  co  "li"
 *   externalId eq "okta-uuid"
 *
 * Returns a Prisma-style where fragment or null for "give me everything".
 * Unsupported filters throw — IdPs interpret a 400 as "filter not supported"
 * and fall back to client-side filtering.
 */
export function parseFilter(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Very intentional: keep the regex strict so unsupported expressions surface
  // loudly instead of being silently mistranslated.
  const m = /^(userName|externalId)\s+(eq|sw|co)\s+"([^"]*)"$/i.exec(trimmed)
  if (!m) throw new Error(`Unsupported filter: ${raw}`)
  const [, attrRaw, opRaw, value] = m
  const attr = attrRaw.toLowerCase()
  const op   = opRaw.toLowerCase()

  if (attr === "username") {
    if (op === "eq") return { username: value }
    if (op === "sw") return { username: { startsWith: value, mode: "insensitive" } }
    if (op === "co") return { username: { contains:   value, mode: "insensitive" } }
  }
  if (attr === "externalid") {
    if (op === "eq") return { scimSubject: { is: { externalId: value } } }
    if (op === "sw") return { scimSubject: { is: { externalId: { startsWith: value } } } }
    if (op === "co") return { scimSubject: { is: { externalId: { contains:   value } } } }
  }
  throw new Error(`Unsupported filter: ${raw}`)
}

/**
 * Apply a SCIM PATCH operations array onto a partial Kaiveron user update.
 * Returns the delta to forward to prisma.user.update; throws for unsupported
 * operations so a misconfigured IdP gets a 400 instead of silent no-ops.
 */
export interface PatchOp { op: string; path?: string; value?: unknown }
export interface UserDelta {
  isBanned?:    boolean
  displayName?: string
  email?:       string
}
export function applyPatchOps(ops: PatchOp[]): UserDelta {
  const delta: UserDelta = {}
  for (const op of ops) {
    const action = String(op.op ?? "").toLowerCase()
    if (action !== "replace" && action !== "add" && action !== "remove") {
      throw new Error(`Unsupported op: ${op.op}`)
    }
    const path = String(op.path ?? "").trim()
    // Path-less replace with { active: false } is what Okta/Azure send for deactivation
    if (!path && op.value && typeof op.value === "object") {
      const v = op.value as Record<string, unknown>
      if (typeof v.active      === "boolean") delta.isBanned    = !v.active
      if (typeof v.displayName === "string")  delta.displayName = v.displayName
      const emails = v.emails as Array<{ value: string; primary?: boolean }> | undefined
      if (Array.isArray(emails) && emails[0]?.value) delta.email = emails[0].value
      continue
    }
    if (path.toLowerCase() === "active") {
      if (action === "remove")            delta.isBanned = false    // reactivation
      else if (typeof op.value === "boolean") delta.isBanned = !op.value
      else throw new Error("active patch requires boolean value")
      continue
    }
    if (path.toLowerCase() === "displayname") {
      if (typeof op.value === "string") delta.displayName = op.value
      continue
    }
    if (path.toLowerCase() === "emails[primary eq true].value" || path.toLowerCase() === "emails.value") {
      if (typeof op.value === "string") delta.email = op.value
      continue
    }
    // Unknown path — log via thrown error so IdP sees 400
    throw new Error(`Unsupported PATCH path: ${path}`)
  }
  return delta
}

/** Discovery: ServiceProviderConfig (RFC 7643 §5). */
export function serviceProviderConfig(baseUrl: string): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://kaiveron.com/docs/scim",
    patch:         { supported: true },
    bulk:          { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter:        { supported: true, maxResults: 200 },
    changePassword:{ supported: false },
    sort:          { supported: false },
    etag:          { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Issue via POST /api/v1/oauth/token with scope=scim",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  }
}

export function resourceTypes(baseUrl: string): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "Kaiveron user account",
        schema: USER_CORE_SCHEMA,
        meta: { location: `${baseUrl}/ResourceTypes/User`, resourceType: "ResourceType" },
      },
    ],
  }
}

export function schemas(baseUrl: string): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 1,
    Resources: [
      {
        id: USER_CORE_SCHEMA,
        name: "User",
        description: "Kaiveron user — subset of SCIM core User",
        attributes: [
          { name: "userName",    type: "string",  multiValued: false, required: true,  uniqueness: "server" },
          { name: "displayName", type: "string",  multiValued: false, required: true },
          { name: "active",      type: "boolean", multiValued: false, required: false },
          { name: "emails",      type: "complex", multiValued: true,  required: false,
            subAttributes: [
              { name: "value",   type: "string",  required: true },
              { name: "primary", type: "boolean", required: false },
              { name: "type",    type: "string",  required: false },
            ],
          },
        ],
        meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${USER_CORE_SCHEMA}` },
      },
    ],
  }
}
