import { describe, it, expect } from "vitest"
import {
  userToScim, listResponse, scimError, parseFilter, applyPatchOps,
  serviceProviderConfig, resourceTypes, schemas,
} from "../app/src/lib/scim"

const sampleUser = {
  id:          "u1",
  email:       "alice@example.com",
  username:    "alice",
  displayName: "Alice Smith",
  isBanned:    false,
  createdAt:   new Date("2026-01-01T00:00:00Z"),
  updatedAt:   new Date("2026-01-02T00:00:00Z"),
}

describe("scim lib — userToScim", () => {
  it("emits SCIM core schema + active=true for unbanned user", () => {
    const out = userToScim(sampleUser, "okta-123", "https://api.kaiveron.com/scim/v2")
    expect(out.schemas).toContain("urn:ietf:params:scim:schemas:core:2.0:User")
    expect(out.userName).toBe("alice")
    expect(out.active).toBe(true)
    expect(out.externalId).toBe("okta-123")
    expect(out.emails[0]).toMatchObject({ value: "alice@example.com", primary: true, type: "work" })
    expect(out.meta.location).toBe("https://api.kaiveron.com/scim/v2/Users/u1")
  })

  it("maps isBanned=true → active=false", () => {
    const out = userToScim({ ...sampleUser, isBanned: true }, null, "https://x/scim/v2")
    expect(out.active).toBe(false)
    expect(out.externalId).toBeNull()
  })
})

describe("scim lib — parseFilter", () => {
  it("returns null for empty filter", () => {
    expect(parseFilter(undefined)).toBeNull()
    expect(parseFilter("")).toBeNull()
  })

  it("parses userName eq", () => {
    expect(parseFilter('userName eq "alice"')).toEqual({ username: "alice" })
  })

  it("parses userName sw (case-insensitive)", () => {
    expect(parseFilter('userName sw "al"')).toEqual({ username: { startsWith: "al", mode: "insensitive" } })
  })

  it("parses externalId eq with relation traversal", () => {
    expect(parseFilter('externalId eq "okta-1"')).toEqual({ scimSubject: { is: { externalId: "okta-1" } } })
  })

  it("throws on unsupported operator", () => {
    expect(() => parseFilter('userName gt "alice"')).toThrow(/Unsupported/)
  })

  it("throws on unsupported attribute", () => {
    expect(() => parseFilter('emails eq "x"')).toThrow(/Unsupported/)
  })
})

describe("scim lib — applyPatchOps", () => {
  it("Okta-style deactivation: { op: replace, value: { active: false } } → isBanned=true", () => {
    const delta = applyPatchOps([{ op: "replace", value: { active: false } }])
    expect(delta.isBanned).toBe(true)
  })

  it("path-based replace on active", () => {
    expect(applyPatchOps([{ op: "replace", path: "active", value: true }]).isBanned).toBe(false)
    expect(applyPatchOps([{ op: "replace", path: "active", value: false }]).isBanned).toBe(true)
  })

  it("displayName replace", () => {
    expect(applyPatchOps([{ op: "replace", path: "displayName", value: "Bob" }]).displayName).toBe("Bob")
  })

  it("email via complex filter path", () => {
    const d = applyPatchOps([{ op: "replace", path: 'emails[primary eq true].value', value: "new@x.com" }])
    expect(d.email).toBe("new@x.com")
  })

  it("throws on unknown op", () => {
    expect(() => applyPatchOps([{ op: "bogus", path: "active", value: true }])).toThrow(/Unsupported op/)
  })

  it("throws on unknown path", () => {
    expect(() => applyPatchOps([{ op: "replace", path: "weirdField", value: "x" }])).toThrow(/Unsupported PATCH path/)
  })

  it("remove on active treats as reactivation", () => {
    expect(applyPatchOps([{ op: "remove", path: "active" }]).isBanned).toBe(false)
  })
})

describe("scim lib — listResponse + scimError + discovery", () => {
  it("listResponse wraps with the correct SCIM message schema", () => {
    const r = listResponse([], 0, 1, 0) as Record<string, unknown>
    expect(r.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse")
    expect(r.totalResults).toBe(0)
    expect(r.startIndex).toBe(1)
  })

  it("scimError includes scimType when supplied", () => {
    const e = scimError(409, "duplicate", "uniqueness")
    expect(e.status).toBe(409)
    expect(e.body.scimType).toBe("uniqueness")
    expect((e.body.schemas as string[])).toContain("urn:ietf:params:scim:api:messages:2.0:Error")
  })

  it("ServiceProviderConfig declares patch supported + bulk not supported", () => {
    const cfg = serviceProviderConfig("https://x/scim/v2") as { patch: { supported: boolean }; bulk: { supported: boolean }; authenticationSchemes: Array<{ type: string }> }
    expect(cfg.patch.supported).toBe(true)
    expect(cfg.bulk.supported).toBe(false)
    expect(cfg.authenticationSchemes[0].type).toBe("oauthbearertoken")
  })

  it("ResourceTypes + Schemas return the User core schema", () => {
    const rt = resourceTypes("https://x/scim/v2") as { Resources: Array<{ id: string; schema: string }> }
    expect(rt.Resources[0].id).toBe("User")
    const sc = schemas("https://x/scim/v2") as { Resources: Array<{ id: string }> }
    expect(sc.Resources[0].id).toBe("urn:ietf:params:scim:schemas:core:2.0:User")
  })
})
