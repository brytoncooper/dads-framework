import type { SubjectRef } from "./authorization.js";

/**
 * Where the resource id for a route-level check comes from. The source names
 * the RESOURCE side of the question only — the subject is always the
 * session/JWT-resolved caller; nothing client-supplied ever names the
 * subject. Resolution happens at the edge (the kit); this table only ever
 * sees the resolved id.
 */
export type ResourceIdSource =
  | { kind: "param"; name: string }
  | { kind: "body"; name: string }
  | { kind: "query"; name: string }
  | { kind: "header"; name: string }
  | { kind: "fixed"; id: string }
  | { kind: "none" };

/** A route's declared permission requirement. */
export type RequirePermissionMetadata = {
  resourceType: string;
  permission: string;
  source: ResourceIdSource;
};

/**
 * The guard's pure decision (docs/testing/README.md — guards are tested as
 * pure decisions plus one e2e for the wiring). Given the route's metadata,
 * the resolved subject, and the check outcome, produce the verdict.
 */
export type RouteAccessInput = {
  isPublic: boolean;
  sessionOnly: boolean;
  permission: RequirePermissionMetadata | undefined;
  subject: SubjectRef | null;
  resourceId: string | undefined;
  /** result of Authorization.check, when a permission check applies */
  checkResult?: boolean;
};

export type RouteAccessVerdict =
  | { outcome: "allow" }
  | { outcome: "unauthenticated" } // → 401
  | { outcome: "not-found" } // failed/impossible check → 404, never leak existence
  | {
      outcome: "check";
      resource: { type: string; id: string };
      permission: string;
    };

/**
 * Two-phase evaluation: call once without checkResult to learn whether a
 * check() is needed (outcome "check"), then again with the result.
 */
export function evaluateRouteAccess(input: RouteAccessInput): RouteAccessVerdict {
  if (input.isPublic) {
    return { outcome: "allow" };
  }
  if (!input.permission && !input.sessionOnly) {
    // Routes outside the domain walls carry no metadata (health, root).
    return { outcome: "allow" };
  }
  if (!input.subject) {
    return { outcome: "unauthenticated" };
  }
  if (!input.permission) {
    return { outcome: "allow" }; // @RequireSession — mutation/query owns authorization
  }
  if (!input.resourceId) {
    // Misconfigured route (param missing) — fail closed.
    return { outcome: "not-found" };
  }
  if (input.checkResult === undefined) {
    return {
      outcome: "check",
      resource: {
        type: input.permission.resourceType,
        id: input.resourceId,
      },
      permission: input.permission.permission,
    };
  }
  return input.checkResult ? { outcome: "allow" } : { outcome: "not-found" };
}
