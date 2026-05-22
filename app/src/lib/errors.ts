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

export const forbidden = (msg = "Forbidden") =>
  new HttpError(403, "FORBIDDEN", msg);

export const conflict = (msg = "Conflict") =>
  new HttpError(409, "CONFLICT", msg);

export const badReq = (msg = "Bad request") =>
  new HttpError(400, "BAD_REQUEST", msg);

// Alias for consistency
export const badRequest = badReq;

export const unauth = (msg = "Unauthorized") =>
  new HttpError(401, "UNAUTHORIZED", msg);

export const internal = (msg = "Internal server error") =>
  new HttpError(500, "INTERNAL", msg);

export const configError = (msg = "Service not configured") =>
  new HttpError(503, "NOT_CONFIGURED", msg);
