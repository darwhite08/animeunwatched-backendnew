/**
 * Minimal OpenAPI 3.1 types — enough to keep buildSpec()'s output strongly
 * typed without dragging in `openapi-types` (~600 KB) for documentation.
 */

export interface OpenAPIObject {
  openapi: "3.1.0"
  info: {
    title: string
    version: string
    description?: string
    contact?: { name?: string; url?: string; email?: string }
    license?: { name: string; url?: string }
  }
  servers?: Array<{ url: string; description?: string }>
  paths: Record<string, PathItemObject>
  components?: {
    securitySchemes?: Record<string, SecuritySchemeObject>
    schemas?: Record<string, Record<string, unknown>>
  }
  tags?: Array<{ name: string; description?: string }>
}

export interface PathItemObject {
  get?:     OperationObject
  post?:    OperationObject
  put?:     OperationObject
  patch?:   OperationObject
  delete?:  OperationObject
  head?:    OperationObject
  options?: OperationObject
}

export interface OperationObject {
  summary?:     string
  description?: string
  tags?:        string[]
  parameters?:  Array<{ name: string; in: "path" | "query" | "header"; required?: boolean; description?: string; schema?: { type: string; enum?: unknown[] } }>
  requestBody?: {
    required?: boolean
    content:   Record<string, { schema: Record<string, unknown> }>
  }
  responses:   Record<string, { description: string; content?: Record<string, { schema: Record<string, unknown> }> }>
  security?:   Array<Record<string, string[]>>
}

export interface SecuritySchemeObject {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect"
  scheme?: string
  bearerFormat?: string
  in?: "query" | "header" | "cookie"
  name?: string
  description?: string
}
