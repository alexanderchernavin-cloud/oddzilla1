// Typed HTTP errors that Fastify's errorHandler maps to JSON responses.
// Never leak raw internal errors to clients.

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Bad request", code = "bad_request") {
    super(400, code, message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized", code = "unauthorized") {
    super(401, code, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden", code = "forbidden") {
    super(403, code, message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found", code = "not_found") {
    super(404, code, message);
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict", code = "conflict") {
    super(409, code, message);
  }
}

export class InternalError extends ApiError {
  constructor(message = "Internal error") {
    super(500, "internal_error", message);
  }
}
