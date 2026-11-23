import type { SubjectRef } from "@dads-framework/access/runtime";
import { conflict } from "@dads-framework/core/errors";

import type { FeatureStatePreviewProtocol } from "./feature-state-preview.js";

/**
 * What this kit needs from a request's feature-state snapshot: the hash it
 * writes to the response header and compares on a sensitive write, plus the
 * effective allow-list it hands to handlers untouched. A product's own
 * snapshot type is this shape, so it reaches its handlers without a cast.
 */
export type FeatureStateSnapshot = {
  readonly features: string[];
  readonly stateHash: string;
};

/** Application-bound snapshot evaluator. Null excludes technical or unauthenticated traffic. */
export type FeatureStateRequestEvaluator = {
  evaluate(input: {
    readonly authenticatedSubject: SubjectRef;
    readonly subject: SubjectRef;
    readonly context: string | undefined;
  }): Promise<FeatureStateSnapshot | null>;
};

/**
 * The application's half of the feature-state protocol: who evaluates a
 * request, and the header names its clients speak. The kit owns the
 * once-per-request protocol; the wire spelling is an agreement between a
 * product's own client and API, so the product names it.
 */
export type FeatureStateProtocol = {
  readonly evaluator: FeatureStateRequestEvaluator;
  /** Response header the current snapshot's hash is written to. */
  readonly hashHeader: string;
  /** Request header carrying the hash the client last saw. */
  readonly clientHashHeader: string;
  /** Request header naming the caller's context, handed to the evaluator. */
  readonly contextHeader: string;
  /** Derives context from matched route parameters instead of reading its context header. */
  readonly contextFromRequest?: (request: { readonly params: unknown }) => string | undefined;
  /**
   * Optional per-caller preview of one feature. Omitted, a preview id header
   * is ignored like any unknown header.
   */
  readonly preview?: FeatureStatePreviewProtocol;
};

type HeaderCarrier = {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly params?: unknown;
};

function oneHeader(request: HeaderCarrier, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export function featureStateContext(
  protocol: FeatureStateProtocol | undefined,
  request: HeaderCarrier,
): string | undefined {
  if (protocol === undefined) return undefined;
  if (protocol.contextFromRequest === undefined) {
    return oneHeader(request, protocol.contextHeader);
  }
  return protocol.contextFromRequest({ params: request.params });
}

/** Resolves a request-local snapshot without retaining a database connection. */
export async function resolveFeatureState(input: {
  readonly protocol: FeatureStateProtocol;
  readonly request: HeaderCarrier;
  readonly authenticatedSubject: SubjectRef | null;
  readonly subject: SubjectRef | null;
}): Promise<FeatureStateSnapshot | null> {
  if (!input.authenticatedSubject || !input.subject) return null;
  const snapshot = await input.protocol.evaluator.evaluate({
    authenticatedSubject: input.authenticatedSubject,
    subject: input.subject,
    context: featureStateContext(input.protocol, input.request),
  });
  return snapshot;
}

/** Rejects only a supplied stale mutation hash, after its refresh hash is written. */
export function assertFeatureStateWriteIsCurrent(input: {
  readonly snapshot: FeatureStateSnapshot | null;
  readonly clientHashHeader: string;
  readonly request: HeaderCarrier;
  readonly method: string;
  readonly featureStateWrite: "sensitive" | undefined;
}): void {
  if (!input.snapshot) return;
  const supplied = oneHeader(input.request, input.clientHashHeader);
  const writes =
    input.method === "POST" || input.method === "PUT" || input.method === "PATCH" || input.method === "DELETE";
  if (
    writes &&
    input.featureStateWrite === "sensitive" &&
    supplied !== undefined &&
    supplied !== input.snapshot.stateHash
  ) {
    throw conflict("STALE_FEATURE_STATE", "Feature state changed; refresh before retrying this write", {
      currentFeatureStateHash: input.snapshot.stateHash,
    });
  }
}

/** Keeps the exact public header spelling at the shared HTTP seam. */
export function writeFeatureStateHash(
  reply: { header(name: string, value: string): unknown },
  hashHeader: string,
  snapshot: FeatureStateSnapshot | null,
): void {
  if (snapshot) void reply.header(hashHeader, snapshot.stateHash);
}
