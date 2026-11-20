import type { z } from "zod";

/**
 * Typed failures the kit itself can produce while running a route. The error
 * handler maps each to exactly one HTTP outcome; nothing else in the kit
 * decides status codes (docs/architecture/type-safety.md).
 */

/** Which part of the request failed validation. */
export type RequestPart = "params" | "query" | "body";

/** A request that failed its Zod schema — becomes a 400 with field issues. */
export class RequestValidationError extends Error {
  constructor(
    readonly part: RequestPart,
    override readonly cause: z.ZodError,
  ) {
    super(`request ${part} failed validation`);
    this.name = "RequestValidationError";
  }
}

/**
 * A handler returned data that does not satisfy the route's response schema.
 * This is a programming error, never a client error — it becomes a loud 500
 * (the `@ZodResponse` drift-fails-at-the-boundary posture, preserved).
 */
export class ResponseDriftError extends Error {
  constructor(
    readonly routePath: string,
    override readonly cause: z.ZodError,
  ) {
    super(`response for ${routePath} drifted from its schema`);
    this.name = "ResponseDriftError";
  }
}

/**
 * The kit was asked to run a route in a state its access declaration rules
 * out (e.g. a session-guarded handler invoked with no subject). Defensive —
 * the access hook prevents this; reaching it is a wiring bug, a loud 500.
 */
export class HttpWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpWiringError";
  }
}

/**
 * A handler exceeded the kit's hard deadline. The socket is released with a
 * 503 and the incident is logged loud — a hung handler must never pin a
 * connection (process-discipline bar).
 */
export class HandlerTimeoutError extends Error {
  constructor(
    readonly routePath: string,
    readonly afterMs: number,
  ) {
    super(`handler for ${routePath} exceeded ${afterMs}ms`);
    this.name = "HandlerTimeoutError";
  }
}

/**
 * An infrastructure dependency the route needs is unavailable (readiness
 * probes, upstream outages) — a 503 with a stable code, expected rather
 * than masked.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
