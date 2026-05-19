/**
 * Error factory helpers unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  HttpError,
  notFound,
  forbidden,
  conflict,
  badReq,
  badRequest,
  unauth,
  internal,
} from "../app/src/lib/errors";

describe("HttpError factories", () => {
  it("notFound returns 404 NOT_FOUND", () => {
    const err = notFound("Missing anime");
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Missing anime");
  });

  it("notFound uses default message", () => {
    const err = notFound();
    expect(err.message).toBe("Not found");
  });

  it("forbidden returns 403 FORBIDDEN", () => {
    const err = forbidden();
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("conflict returns 409 CONFLICT", () => {
    const err = conflict("Email in use");
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Email in use");
  });

  it("badReq returns 400 BAD_REQUEST", () => {
    const err = badReq("Missing field");
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
  });

  it("badRequest is an alias for badReq", () => {
    expect(badRequest("x").code).toBe(badReq("x").code);
    expect(badRequest("x").status).toBe(badReq("x").status);
  });

  it("unauth returns 401 UNAUTHORIZED", () => {
    const err = unauth("Invalid token");
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Invalid token");
  });

  it("internal returns 500 INTERNAL", () => {
    const err = internal();
    expect(err.status).toBe(500);
    expect(err.code).toBe("INTERNAL");
  });

  it("instanceof checks work through prototype chain", () => {
    const err = notFound();
    expect(err instanceof HttpError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
