export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const notFound = (msg = "Not found") =>
  new HttpError(404, "NOT_FOUND", msg);

export const forbidden = (msg = "Forbidden", code = "FORBIDDEN") =>
  new HttpError(403, code, msg);

export const conflict = (msg = "Conflict") =>
  new HttpError(409, "CONFLICT", msg);

export const badReq = (msg = "Bad request", code = "BAD_REQUEST") =>
  new HttpError(400, code, msg);

// Alias for consistency
export const badRequest = badReq;

export const unauth = (msg = "Unauthorized", code = "UNAUTHORIZED") =>
  new HttpError(401, code, msg);

export const internal = (msg = "Internal server error") =>
  new HttpError(500, "INTERNAL", msg);

export const configError = (msg = "Service not configured") =>
  new HttpError(503, "NOT_CONFIGURED", msg);
