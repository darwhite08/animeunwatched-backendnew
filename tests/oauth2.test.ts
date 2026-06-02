import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    oauthClient: {
      findUnique: vi.fn(),
      update:     vi.fn(),
    },
    oauthAccessToken: {
      create:     vi.fn(),
      findUnique: vi.fn(),
      update:     vi.fn(),
    },
  },
}))

import { issueClientCredentialsToken, verifyAccessToken, hash, generateClientId, generateClientSecret, generateAccessToken, OAuthError, hasScope, isKnownScope } from "../app/src/lib/oauth2"

describe("oauth2 lib", () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe("generators", () => {
    it("client ids have the expected prefix + entropy", () => {
      const id = generateClientId()
      expect(id).toMatch(/^ka_oc_[a-f0-9]{32}$/)
      const id2 = generateClientId()
      expect(id).not.toBe(id2)
    })
    it("secrets and tokens have prefixes too", () => {
      expect(generateClientSecret()).toMatch(/^ka_sk_[a-f0-9]{64}$/)
      expect(generateAccessToken()).toMatch(/^ka_at_[a-f0-9]{64}$/)
    })
  })

  describe("issueClientCredentialsToken", () => {
    it("rejects unknown client_id", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue(null)
      await expect(issueClientCredentialsToken({ clientId: "nope", clientSecret: "x" }))
        .rejects.toMatchObject({ code: "invalid_client" })
    })

    it("rejects revoked client", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", clientId: "id", clientSecretHash: hash("good"), scopes: [], revokedAt: new Date() })
      await expect(issueClientCredentialsToken({ clientId: "id", clientSecret: "good" }))
        .rejects.toMatchObject({ code: "invalid_client" })
    })

    it("rejects bad secret", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", clientId: "id", clientSecretHash: hash("good"), scopes: [], revokedAt: null })
      await expect(issueClientCredentialsToken({ clientId: "id", clientSecret: "WRONG" }))
        .rejects.toMatchObject({ code: "invalid_client" })
    })

    it("intersects requested scope with client scope", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
        oauthAccessToken: { create: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", clientId: "id", clientSecretHash: hash("good"), scopes: ["read:users","scim"], revokedAt: null })
      prisma.oauthAccessToken.create.mockResolvedValue({})
      prisma.oauthClient.update.mockResolvedValue({})
      const t = await issueClientCredentialsToken({ clientId: "id", clientSecret: "good", requestedScope: "read:users write:webhooks" })
      expect(t.scope).toBe("read:users")            // write:webhooks dropped (not in client.scopes)
    })

    it("rejects when all requested scopes are unknown to the client", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", clientId: "id", clientSecretHash: hash("good"), scopes: ["read:users"], revokedAt: null })
      await expect(issueClientCredentialsToken({ clientId: "id", clientSecret: "good", requestedScope: "write:posts" }))
        .rejects.toMatchObject({ code: "invalid_scope" })
    })

    it("falls back to client scopes when no scope is requested", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthClient: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
        oauthAccessToken: { create: ReturnType<typeof vi.fn> }
      }
      prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", clientId: "id", clientSecretHash: hash("good"), scopes: ["read:users","scim"], revokedAt: null })
      prisma.oauthAccessToken.create.mockResolvedValue({})
      prisma.oauthClient.update.mockResolvedValue({})
      const t = await issueClientCredentialsToken({ clientId: "id", clientSecret: "good" })
      expect(t.scope.split(" ").sort()).toEqual(["read:users","scim"])
    })
  })

  describe("verifyAccessToken", () => {
    it("throws for unknown token", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthAccessToken: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthAccessToken.findUnique.mockResolvedValue(null)
      await expect(verifyAccessToken("ka_at_nope")).rejects.toMatchObject({ code: "invalid_token" })
    })

    it("throws for expired token", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthAccessToken: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthAccessToken.findUnique.mockResolvedValue({
        id: "t1", clientId: "c1", scopes: [], expiresAt: new Date(Date.now() - 1000),
        revokedAt: null, client: { id: "c1", name: "x", clientId: "ka_oc_x", revokedAt: null },
      })
      await expect(verifyAccessToken("ka_at_x")).rejects.toMatchObject({ code: "invalid_token" })
    })

    it("throws when the client was revoked after token mint", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthAccessToken: { findUnique: ReturnType<typeof vi.fn> }
      }
      prisma.oauthAccessToken.findUnique.mockResolvedValue({
        id: "t1", clientId: "c1", scopes: [], expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null, client: { id: "c1", name: "x", clientId: "ka_oc_x", revokedAt: new Date() },
      })
      await expect(verifyAccessToken("ka_at_x")).rejects.toMatchObject({ code: "invalid_token" })
    })

    it("returns the verified record on success", async () => {
      const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
        oauthAccessToken: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
      }
      prisma.oauthAccessToken.findUnique.mockResolvedValue({
        id: "t1", clientId: "c1", scopes: ["scim"], expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null, client: { id: "c1", name: "Zapier", clientId: "ka_oc_x", revokedAt: null },
      })
      prisma.oauthAccessToken.update.mockResolvedValue({})
      const v = await verifyAccessToken("ka_at_x")
      expect(v.client.name).toBe("Zapier")
      expect(v.scopes).toEqual(["scim"])
    })
  })

  describe("hasScope / isKnownScope", () => {
    it("checks scope membership", () => {
      const v = { tokenId: "t", clientId: "c", client: { id: "c", name: "x", clientId: "x" }, scopes: ["scim","read:users"], expiresAt: new Date() }
      expect(hasScope(v, "scim")).toBe(true)
      expect(hasScope(v, "admin:read")).toBe(false)
    })
    it("rejects unknown scope names in isKnownScope", () => {
      expect(isKnownScope("scim")).toBe(true)
      expect(isKnownScope("write:literally_anything")).toBe(false)
    })
  })

  it("OAuthError carries code + status", () => {
    const e = new OAuthError("invalid_grant", "Bad grant", 400)
    expect(e.code).toBe("invalid_grant")
    expect(e.status).toBe(400)
  })
})
