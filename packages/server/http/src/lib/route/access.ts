import type { PermissionToken } from "@dads-framework/access";

/**
 * The route access vocabulary — the entire authorization surface at the HTTP
 * edge. Every route declares exactly one of these three; every verb function
 * requires the declaration at the type level, so an unguarded route does not
 * compile (docs/architecture/authorization.md).
 *
 * Permission math lives in the .zed schema, never here. Typed ask constructors
 * (`requires` / `requiresVisible`) live in `@dads-framework/access` and emit the
 * shapes below; this module keeps session/public constructors and resource-id
 * sources.
 */

/** Where the resource id for a permission check comes from. */
export type ResourceIdSource =
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "body"; readonly name: string }
  | { readonly kind: "query"; readonly name: string }
  | { readonly kind: "header"; readonly name: string }
  | { readonly kind: "fixed"; readonly id: string };

/** The resource id is the named path parameter (e.g. `fromParam("id")`). */
export function fromParam(name: string): ResourceIdSource {
  return { kind: "param", name };
}

/**
 * The resource id is the named top-level body field (e.g.
 * `fromBody("organizationId")`) — for flat-collection creates, where the
 * parent being created into has no path segment. The body names only the
 * RESOURCE side of the question; the SUBJECT is always the session/JWT
 * caller — pointing at a resource you have no relationship to fails closed
 * as 404. Enforcement reads the raw field before body validation: anything
 * but a string resolves like a missing param (404, never a 500).
 */
export function fromBody(name: string): ResourceIdSource {
  return { kind: "body", name };
}

/**
 * The resource id is the named query parameter (e.g. `fromQuery("facilityId")`)
 * — for flat facility-scoped surfaces where the parent is a filter, not a
 * path segment. Same fail-closed rules as fromBody: non-string → 404.
 */
export function fromQuery(name: string): ResourceIdSource {
  return { kind: "query", name };
}

/** Read one request-local header; repeated values are never a valid identity source. */
export function fromHeader(name: string): ResourceIdSource {
  return { kind: "header", name: name.toLowerCase() };
}

/**
 * The resource id is a compile-time constant (e.g. `fromFixed("command")` for
 * the singleton `platform:command` resource). Use when the route's permission
 * check targets a well-known resource that is not in the path or body.
 */
export function fromFixed(id: string): ResourceIdSource {
  return { kind: "fixed", id };
}

/**
 * Route-level relationship check: subject must hold `permission` on the
 * resource of `resourceType` identified by `resourceId`.
 *
 * Prefer `requires(token, source)` at call sites.
 */
export type PermissionAccess = {
  readonly kind: "permission";
  readonly resourceType: string;
  readonly permission: string;
  readonly resourceId: ResourceIdSource;
  readonly authorizationContext?: ResourceIdSource;
  readonly authorizationContextMode?: "technical-or-business";
};

/**
 * Authenticated subject required; no route-level resource check. For
 * collection routes (create/list) where authorization happens inside the
 * use-case — lookupResources for lists, ownership-tuple writes for creates.
 */
export type SessionAccess = {
  readonly kind: "session";
  readonly authorizationContext?: ResourceIdSource;
  readonly authorizationContextMode?: "technical-or-business";
  /** Input only: the owning operation must select and authorize its explicit runtime authority. */
  readonly authorizationContextInput?: ResourceIdSource;
};

/** Explicit opt-in for genuinely unauthenticated routes (health, auth). */
export type PublicAccess = { readonly kind: "public" };

/**
 * List-route visibility: the kit asks `lookupResources` which resources of
 * `resourceType` the SUBJECT can `permission`, short-circuits an empty set
 * to an empty page (fail-closed — the empty-`IN ()` widening footgun cannot
 * exist), and hands the handler the visible ids. Only `listRoute` admits
 * this kind — a set question makes no sense on a single-resource verb, and
 * the verbs' type constraints enforce that at compile time.
 *
 * Prefer `requiresVisible(token)` at call sites.
 */
export type VisibilityAccess = {
  readonly kind: "visibility";
  readonly resourceType: string;
  readonly permission: string;
  readonly authorizationContext?: ResourceIdSource;
  readonly authorizationContextMode?: "technical-or-business";
};

/**
 * Record-list scoping: registration compiles the scope plan for
 * `permission` on `resourceType` (refusing to boot when the record's bindings
 * cannot carry it); each request asks SpiceDB the plan's scope questions once
 * each and hands the handler a `ScopeAnswer` to render as SQL with
 * `scopePredicate`, then re-check the page with `keepPermitted`. No empty-set
 * short-circuit: the SQL decides, since one empty arm of an `any` can still
 * match. Only `listRoute` admits this kind.
 *
 * Prefer `requiresScoped(token)` at call sites.
 */
export type ScopedAccess = {
  readonly kind: "scoped";
  readonly resourceType: string;
  readonly permission: string;
  readonly authorizationContext?: ResourceIdSource;
  readonly authorizationContextMode?: "technical-or-business";
};

export type RouteAccess = PermissionAccess | SessionAccess | PublicAccess | VisibilityAccess | ScopedAccess;

/** Require a relationship on the resource identified by the supplied source. */
export function requires(token: PermissionToken, resourceId: ResourceIdSource): PermissionAccess {
  return {
    kind: "permission",
    resourceType: token.entityWireName,
    permission: token.permissionName,
    resourceId,
  };
}

/** List IDs the caller may see for a bounded resource type. */
export function requiresVisible(token: PermissionToken): VisibilityAccess {
  return {
    kind: "visibility",
    resourceType: token.entityWireName,
    permission: token.permissionName,
  };
}

/** Filter a record list using the scope bindings in the app's access model. */
export function requiresScoped(token: PermissionToken): ScopedAccess {
  return {
    kind: "scoped",
    resourceType: token.entityWireName,
    permission: token.permissionName,
  };
}

/** Resolve explicit caller authority before checking this route's business access. */
export function withAuthorizationContext<Access extends Exclude<RouteAccess, PublicAccess>>(
  access: Access,
  source: ResourceIdSource,
): Access & { readonly authorizationContext: ResourceIdSource } {
  if (access.kind === "session" && access.authorizationContextInput !== undefined)
    throw new Error("Resolved and input-only authorization contexts cannot be combined");
  if (access.authorizationContextMode !== undefined)
    throw new Error("Required and technical-or-business authorization contexts cannot be combined");
  return { ...access, authorizationContext: source };
}

/** Explicitly technical routes may omit context; any supplied context must resolve and never falls back to technical identity. */
export function withTechnicalOrBusinessAuthorizationContext<Access extends Exclude<RouteAccess, PublicAccess>>(
  access: Access,
  source: ResourceIdSource,
): Access & {
  readonly authorizationContext: ResourceIdSource;
  readonly authorizationContextMode: "technical-or-business";
} {
  if (source.kind !== "header" && source.kind !== "query")
    throw new Error("Technical-or-business context requires a declared header or query");
  if (
    access.authorizationContext !== undefined ||
    (access.kind === "session" && access.authorizationContextInput !== undefined)
  )
    throw new Error("Technical-or-business authorization cannot be combined with another context declaration");
  return {
    ...access,
    authorizationContext: source,
    authorizationContextMode: "technical-or-business",
  };
}

export function requireSession(): SessionAccess {
  return { kind: "session" };
}

/** Capture untrusted context data for a session-only operation; never resolve or authorize an actor here. */
export function withAuthorizationContextInput(
  access: SessionAccess,
  source: ResourceIdSource,
): SessionAccess & { readonly authorizationContextInput: ResourceIdSource } {
  if (access.authorizationContext !== undefined)
    throw new Error("Resolved and input-only authorization contexts cannot be combined");
  return { ...access, authorizationContextInput: source };
}

export function publicAccess(): PublicAccess {
  return { kind: "public" };
}
