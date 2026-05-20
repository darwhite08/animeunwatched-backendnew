/**
 * Error middleware unit tests.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { ZodError, z } from "zod";
import { HttpError, notFound, badReq, unauth } from "../app/src/lib/errors";

function makeRes(): Response {
  const res: Partial<Response> & { locals: Record<string, unknown> } = {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("errorHandler middleware", () => {
  it("handles HttpError with correct status and error body", async () => {
    const { errorHandler } = await import("../app/src/middlewares/error.middleware");

    const err = notFound("Anime not found");
    const res = makeRes();
    const next = vi.fn();

    errorHandler(err, {} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "NOT_FOUND", message: "Anime not found" },
    });
  });

  it("handles ZodError with 400 VALIDATION", async () => {
    const { errorHandler } = await import("../app/src/middlewares/error.middleware");

    let zodErr: ZodError;
    try {
      z.object({ name: z.string().min(1) }).parse({ name: "" });
    } catch (e) {
      zodErr = e as ZodError;
    }

    const res = makeRes();
    errorHandler(zodErr!, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "VALIDATION" }),
    }));
  });

  it("handles unknown errors with 500 INTERNAL", async () => {
    const { errorHandler } = await import("../app/src/middlewares/error.middleware");

    const res = makeRes();
    errorHandler(new Error("Something exploded"), {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    // In test/dev environment, response may include 'detail' field (OWASP A10 guard only strips it in production)
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.error.code).toBe("INTERNAL");
    expect(call.error.message).toBe("Internal server error");
  });

  it("handles 401 HttpError correctly", async () => {
    const { errorHandler } = await import("../app/src/middlewares/error.middleware");

    const err = unauth("Token expired");
    const res = makeRes();
    errorHandler(err, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("handles 400 BadRequest correctly", async () => {
    const { errorHandler } = await import("../app/src/middlewares/error.middleware");

    const err = badReq("Missing required field");
    const res = makeRes();
    errorHandler(err, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "BAD_REQUEST", message: "Missing required field" },
    });
  });
});
