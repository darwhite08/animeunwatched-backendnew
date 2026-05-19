/**
 * Error factory comprehensive tests — all edge cases and instanceof checks.
 */
import { describe, it, expect } from "vitest";
import {
  HttpError,
  notFound, forbidden, conflict, badReq, badRequest, unauth, internal
} from "../app/src/lib/errors";

describe("HttpError class", () => {
  it("extends Error", () => {
    const err = new HttpError(400, "BAD", "msg")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HttpError)
  })

  it("has correct name 'HttpError'", () => {
    const err = new HttpError(400, "BAD", "msg")
    expect(err.name).toBe("HttpError")
  })

  it("stores status, code, message correctly", () => {
    const err = new HttpError(403, "FORBIDDEN", "No access")
    expect(err.status).toBe(403)
    expect(err.code).toBe("FORBIDDEN")
    expect(err.message).toBe("No access")
  })

  it("can be caught as Error", () => {
    function throwHttpError() { throw new HttpError(500, "INTERNAL", "Server failed") }
    expect(throwHttpError).toThrow(Error)
  })

  it("can be caught as HttpError", () => {
    function throwHttpError() { throw new HttpError(500, "INTERNAL", "Server failed") }
    expect(throwHttpError).toThrow(HttpError)
  })

  it("has stack trace", () => {
    const err = new HttpError(400, "BAD", "msg")
    expect(err.stack).toBeDefined()
    expect(typeof err.stack).toBe("string")
  })
})

describe("notFound factory", () => {
  it("uses default message", () => {
    expect(notFound().message).toBe("Not found")
  })

  it("uses custom message", () => {
    expect(notFound("Anime not found").message).toBe("Anime not found")
  })

  it("returns 404", () => {
    expect(notFound().status).toBe(404)
  })

  it("uses NOT_FOUND code", () => {
    expect(notFound().code).toBe("NOT_FOUND")
  })
})

describe("forbidden factory", () => {
  it("uses default message", () => {
    expect(forbidden().message).toBe("Forbidden")
  })

  it("returns 403", () => {
    expect(forbidden().status).toBe(403)
  })

  it("uses FORBIDDEN code", () => {
    expect(forbidden().code).toBe("FORBIDDEN")
  })
})

describe("conflict factory", () => {
  it("uses default message", () => {
    expect(conflict().message).toBe("Conflict")
  })

  it("returns 409", () => {
    expect(conflict().status).toBe(409)
  })

  it("uses CONFLICT code", () => {
    expect(conflict().code).toBe("CONFLICT")
  })
})

describe("badReq factory", () => {
  it("returns 400 BAD_REQUEST", () => {
    expect(badReq().status).toBe(400)
    expect(badReq().code).toBe("BAD_REQUEST")
  })

  it("uses custom message", () => {
    expect(badReq("Missing field").message).toBe("Missing field")
  })
})

describe("badRequest alias", () => {
  it("is equivalent to badReq", () => {
    const a = badReq("test")
    const b = badRequest("test")
    expect(a.status).toBe(b.status)
    expect(a.code).toBe(b.code)
    expect(a.message).toBe(b.message)
  })
})

describe("unauth factory", () => {
  it("returns 401 UNAUTHORIZED", () => {
    expect(unauth().status).toBe(401)
    expect(unauth().code).toBe("UNAUTHORIZED")
  })

  it("uses custom message", () => {
    expect(unauth("Token expired").message).toBe("Token expired")
  })
})

describe("internal factory", () => {
  it("returns 500 INTERNAL", () => {
    expect(internal().status).toBe(500)
    expect(internal().code).toBe("INTERNAL")
  })

  it("uses default message", () => {
    expect(internal().message).toBe("Internal server error")
  })
})
