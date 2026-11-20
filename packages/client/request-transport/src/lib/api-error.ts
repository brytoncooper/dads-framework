import { z } from "zod";

import { apiErrorSchema } from "@dads-framework/contract";

/**
 * Re-points a just-constructed error at its own class.
 *
 * Every "is this an expected refusal?" decision in the app is an `instanceof`
 * check on these classes. A script on the page (a browser extension, a link
 * scanner) can replace the global `Error` with a constructor that returns an
 * object of its own; `super()` then hands back that object, whose prototype is
 * plain `Error`, and a 409 or a 401 stops being recognisable as one — it gets
 * reported as a fault and shown as an unknown failure. Setting the prototype after `super()` keeps the class no
 * matter what `Error` was when this module loaded.
 */
function keepOwnPrototype(error: Error, ownClass: { prototype: object }): void {
  if (Object.getPrototypeOf(error) !== ownClass.prototype) {
    Object.setPrototypeOf(error, ownClass.prototype);
  }
}

/**
 * The typed failure every transport verb throws.
 *
 * Callers branch on `code` (the stable SCREAMING_SNAKE identifier the error
 * envelope carries) or on `status` — never on `message`, whose wording the
 * API is free to change (docs/architecture/api-conventions.md).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    keepOwnPrototype(this, new.target);
    this.name = "ApiError";
  }
}

/**
 * A 401, given its own class.
 *
 * An expired or missing session is the one failure the whole app reacts to the
 * same way, so it gets a type an `instanceof` can test instead of a status
 * number every caller has to remember.
 */
export class UnauthorizedError extends ApiError {
  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(401, code, message, details, requestId);
    this.name = "UnauthorizedError";
  }
}

/** A request that never received an HTTP response from the API. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("The API request did not receive a response", { cause });
    keepOwnPrototype(this, new.target);
    this.name = "NetworkError";
  }
}

/** One thing a response said it could not be. Paths and codes, never text. */
export type ContractDriftIssue = {
  /** Where in the response the shape was wrong, e.g. `data.lines.0.quantity`. */
  readonly path: string;
  /** Zod's machine code for the mismatch, e.g. `invalid_type`. */
  readonly code: string;
};

/**
 * Message-free failure data safe to hand to a localized renderer.
 *
 * The server and JavaScript messages remain on their original errors for logs
 * and debugging. They deliberately do not cross this seam into presentation.
 *
 * `cause` is the exception to that rule and the reason it is spelled out
 * below: it carries the ORIGINAL thrown value for telemetry, which previously
 * had nowhere to go — `readClientFailure` classified a `TypeError` from a
 * render, a chunk-load failure, and a contract mismatch identically as
 * `unexpected` and dropped every one of them on the floor. It is for reporting
 * and logging only and is never rendered; the message-free posture of the
 * presentation path is unchanged.
 */
export type ClientFailure =
  | { readonly kind: "session-expired" }
  | { readonly kind: "network"; readonly cause?: unknown }
  | {
      readonly kind: "api";
      readonly status: number;
      readonly code: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  /**
   * The response did not match the contract the client compiled against —
   * the two ends have drifted. Distinguished from `unexpected` because it is
   * the one client-side failure that always means a deployment problem rather
   * than a bug in either end's logic, and because it is actionable: the paths
   * name exactly which fields disagree.
   */
  | {
      readonly kind: "contract-drift";
      readonly issues: readonly ContractDriftIssue[];
    }
  | { readonly kind: "unexpected"; readonly cause?: unknown };

/** Classify a thrown value without making its raw message renderable. */
export function readClientFailure(error: unknown): ClientFailure {
  if (error instanceof UnauthorizedError) {
    return { kind: "session-expired" };
  }
  if (error instanceof NetworkError) {
    return { kind: "network", cause: error.cause };
  }
  if (error instanceof ApiError) {
    return error.details === undefined
      ? { kind: "api", status: error.status, code: error.code }
      : {
          kind: "api",
          status: error.status,
          code: error.code,
          details: error.details,
        };
  }
  if (error instanceof z.ZodError) {
    return { kind: "contract-drift", issues: driftIssues(error) };
  }
  return { kind: "unexpected", cause: error };
}

/**
 * Zod's issues, reduced to what is safe to send anywhere.
 *
 * Paths and codes only. `issue.message` is prose, and a custom refinement is
 * free to compose it from the value it rejected — so a message can quote a
 * customer's data, which must not ride a telemetry event out of the browser.
 * A path names which field disagreed, which is the actionable half anyway.
 */
function driftIssues(error: z.ZodError): readonly ContractDriftIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
  }));
}

const UNAUTHORIZED_STATUS = 401;

/**
 * Turn a failed response into the typed error for its status.
 *
 * The body is parsed with the shared error-envelope contract when it matches
 * and ignored when it does not — a proxy, a gateway, or a crash can answer
 * with HTML, and the caller still deserves a typed failure rather than a
 * parse error from the transport.
 */
export function toApiError(
  status: number,
  body: unknown,
  fallbackRequestId: string,
): ApiError {
  const envelope = apiErrorSchema.safeParse(body);
  const failure = envelope.success
    ? envelope.data.error
    : {
        code: "HTTP_ERROR",
        message: `Request failed with ${status}`,
        details: undefined,
        requestId: undefined,
      };
  const requestId = failure.requestId ?? fallbackRequestId;

  if (status === UNAUTHORIZED_STATUS) {
    return new UnauthorizedError(
      failure.code,
      failure.message,
      failure.details,
      requestId,
    );
  }
  return new ApiError(
    status,
    failure.code,
    failure.message,
    failure.details,
    requestId,
  );
}
