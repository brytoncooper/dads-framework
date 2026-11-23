/**
 * Typed, discriminated domain errors (docs/architecture/type-safety.md#4).
 *
 * `kind` drives the HTTP mapping in the kit's error handler
 * (validation→400, unauthorized→401, forbidden→403, not-found→404,
 * conflict→409). `code` is the stable SCREAMING_SNAKE identifier that travels
 * to clients in the error envelope — it survives message rewording, and
 * clients branch on it, never on `message`. Domain code throws/returns these;
 * it never throws HTTP exceptions.
 */
export type DomainErrorKind =
  "not-found" | "conflict" | "validation" | "forbidden" | "unauthorized";

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Shorthand constructors — the kind is in the name, so use-cases read as
 * one line per outcome: `return err(notFound("ORGANIZATION_NOT_FOUND", ...))`.
 */
export function notFound(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("not-found", code, message, details);
}

/** Conflict (409): the request is valid but collides with current state. */
export function conflict(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("conflict", code, message, details);
}

/** Validation (400): the input itself is unacceptable. */
export function validation(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("validation", code, message, details);
}

/** Forbidden (403): reserved for "you may know this exists but can't act". */
export function forbidden(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("forbidden", code, message, details);
}

/** Unauthorized (401): credential presentation failed authentication. */
export function unauthorized(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("unauthorized", code, message, details);
}
