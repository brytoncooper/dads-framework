import { DomainError, type DomainErrorKind } from "./domain-error.js";

/**
 * The pure decision behind the kit's error handler
 * (docs/architecture/http-edge.md#errors--one-table-one-place): typed domain
 * errors map kind→status; anything else is a 500 that exposes only the
 * correlation id.
 */
export type HttpErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
};

export type HttpErrorResponse = {
  status: number;
  body: HttpErrorEnvelope;
  /** true when the original error is unexpected and must be logged with its stack */
  unexpected: boolean;
};

const KIND_TO_STATUS: Record<DomainErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
};

export function mapErrorToHttpResponse(
  error: unknown,
  requestId: string,
): HttpErrorResponse {
  if (error instanceof DomainError) {
    return {
      status: KIND_TO_STATUS[error.kind],
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      unexpected: false,
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      },
    },
    unexpected: true,
  };
}
