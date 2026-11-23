import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  describeException,
  type DiagnosticsReporter,
} from "@dads-framework/core/runtime/diagnostics";
import {
  type HttpErrorResponse,
  mapErrorToHttpResponse,
} from "@dads-framework/core/errors/map-error-to-http-response";

import {
  HandlerTimeoutError,
  HttpWiringError,
  RequestValidationError,
  ResponseDriftError,
  ServiceUnavailableError,
} from "../http-errors.js";
import {
  rememberErrorCode,
  rememberException,
} from "../request-log/request-outcome.js";
import { requestIdOf } from "./request-id.js";

/**
 * The one place errors become HTTP at this library's edge. Library-native
 * failures are mapped first (they carry structure `mapErrorToHttpResponse`
 * cannot know about); Fastify transport errors (payload too large, malformed
 * JSON) keep their status but get the house error envelope; everything else —
 * domain errors and the unknown — delegates to the existing pure
 * `mapErrorToHttpResponse`, so the kind→status table lives in exactly one
 * file.
 */

const TRANSPORT_CODES: Record<number, string> = {
  400: "VALIDATION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  408: "REQUEST_TIMEOUT",
};

/** Fastify decorates its own errors with a 4xx/5xx statusCode. */
function isTransportError(
  error: unknown,
): error is { statusCode: number; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  );
}

function mapHttpException(
  error: unknown,
  requestId: string,
): HttpErrorResponse | null {
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: `Request ${error.part} failed validation`,
          details: { part: error.part, issues: error.cause.issues },
        },
      },
      unexpected: false,
    };
  }
  if (error instanceof ServiceUnavailableError) {
    return {
      status: 503,
      body: { error: { code: error.code, message: error.message } },
      unexpected: false,
    };
  }
  if (error instanceof HandlerTimeoutError) {
    return {
      status: 503,
      body: {
        error: {
          code: "HANDLER_TIMEOUT",
          message: "The request could not be completed in time",
          requestId,
        },
      },
      unexpected: true,
    };
  }
  // Response drift and wiring bugs are programming errors: the client
  // sees only a masked 500; the log carries the loud specifics.
  if (error instanceof ResponseDriftError || error instanceof HttpWiringError) {
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
  return null;
}

export type ErrorHandlingOptions = {
  /**
   * Where a fault goes besides the log line. Optional so the test
   * harness and every existing caller are unchanged; the default reports
   * nowhere, which is what a caller that never asked for one should get.
   */
  readonly diagnostics?: DiagnosticsReporter;
  readonly release?: string;
  readonly instanceId?: string;
};

export function installErrorHandling(
  app: FastifyInstance,
  options: ErrorHandlingOptions = {},
): void {
  app.setErrorHandler(
    (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = requestIdOf(request);
      const httpMapped = mapHttpException(error, requestId);
      const mapped =
        httpMapped ??
        (isTransportError(error) && error.statusCode < 500
          ? {
              status: error.statusCode,
              body: {
                error: {
                  code: TRANSPORT_CODES[error.statusCode] ?? "HTTP_ERROR",
                  message: error.message,
                },
              },
              unexpected: false,
            }
          : mapErrorToHttpResponse(error, requestId));
      if (mapped.unexpected) {
        request.log.error(
          {
            event: "unhandled.exception",
            requestId,
            err: error,
          },
          "request failed unexpectedly",
        );
        // Beside the line, not instead of it: the line carries the full `err`
        // serialization a human reads, and this carries the type and
        // fingerprint a query groups by.
        rememberException(request, describeException(error));
        options.diagnostics?.captureException({
          error,
          source: "request",
          requestId,
          ...(request.routeOptions.url === undefined
            ? {}
            : { routeId: request.routeOptions.url }),
          ...(options.release === undefined
            ? {}
            : { release: options.release }),
          ...(options.instanceId === undefined
            ? {}
            : { instanceId: options.instanceId }),
        });
      }
      // The envelope is the only place the code exists; the request row wants
      // it, and by `onResponse` the body is already on the wire.
      rememberErrorCode(request, mapped.body.error.code);
      void reply.status(mapped.status).send(mapped.body);
    },
  );

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    rememberErrorCode(request, "NOT_FOUND");
    void reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} does not exist`,
      },
    });
  });
}
