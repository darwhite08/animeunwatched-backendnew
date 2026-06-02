import { describe, it, expect } from "vitest"
import { extractIdentity, normalizeCert } from "../app/src/lib/saml"

const cfg = {
  id: "c1", name: "x", idpEntityId: "i", idpSsoUrl: "https://x", idpSloUrl: null,
  idpCertificate: "MIIB", spEntityId: "https://sp", emailAttribute: "email",
  displayNameAttr: "displayName", autoProvision: true, active: true,
  signRequests: false, wantAssertionsSigned: true,
  spPrivateKey: null, spCertificate: null,
  createdBy: null, createdAt: new Date(), updatedAt: new Date(),
}

describe("saml.normalizeCert", () => {
  it("strips BEGIN/END + whitespace", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBSomething\nMore\n-----END CERTIFICATE-----\n"
    expect(normalizeCert(pem)).toBe("MIIBSomethingMore")
  })

  it("passes through already-stripped cert", () => {
    expect(normalizeCert("MIIBabc")).toBe("MIIBabc")
  })
})

describe("saml.extractIdentity", () => {
  it("reads attribute by exact name", () => {
    const id = extractIdentity({
      nameID: "ignored",
      email: "alice@acme.com",
      displayName: "Alice",
    }, cfg)
    expect(id.email).toBe("alice@acme.com")
    expect(id.displayName).toBe("Alice")
  })

  it("does case-insensitive URI suffix lookup (Okta sends full URIs)", () => {
    const id = extractIdentity({
      nameID: "alice@acme.com",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/EmailAddress": "alice@acme.com",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/DisplayName":  "Alice Smith",
    }, { ...cfg, emailAttribute: "emailAddress", displayNameAttr: "displayName" })
    expect(id.email).toBe("alice@acme.com")
    expect(id.displayName).toBe("Alice Smith")
  })

  it("falls back to nameID when it looks like an email", () => {
    const id = extractIdentity({ nameID: "bob@acme.com" }, cfg)
    expect(id.email).toBe("bob@acme.com")
  })

  it("lowercases + trims the email", () => {
    const id = extractIdentity({ nameID: "x", email: "  ALICE@ACME.COM  " }, cfg)
    expect(id.email).toBe("alice@acme.com")
  })

  it("handles array-valued attributes (some IdPs do this)", () => {
    const id = extractIdentity({
      nameID: "x",
      email: ["alice@acme.com", "alice.alt@acme.com"],
      displayName: ["Alice"],
    }, cfg)
    expect(id.email).toBe("alice@acme.com")
    expect(id.displayName).toBe("Alice")
  })

  it("uses email local-part as displayName when displayName attr missing", () => {
    const id = extractIdentity({ nameID: "x", email: "carol@acme.com" }, cfg)
    expect(id.displayName).toBe("carol")
  })

  it("returns empty email + nameID-derived externalId when nothing matches", () => {
    const id = extractIdentity({ nameID: "okta-uuid-abc" }, cfg)
    expect(id.email).toBe("")
    expect(id.externalId).toBe("okta-uuid-abc")
  })
})
