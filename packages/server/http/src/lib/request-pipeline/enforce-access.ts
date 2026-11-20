import type { ScopePlan } from "@dads-framework/access";
import {
  evaluateRouteAccess,
  type AuthMethod,
  type ResolvedSubject,
  type RouteAccessInput,
  type RouteAccessVerdict,
  type ScopeAnswer,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import { HttpWiringError } from "../http-errors.js";
import type { ResourceIdSource, RouteAccess } from "../route/access.js";
import { enforceScope } from "./enforce-scope.js";
import {
  isTechnicalContextAbsent,
  resolveResourceId,
} from "./logic/read-request-source.js";

/**
 * The two ports access enforcement needs — structurally satisfied by the
 * authz lib's `RequestSubject` and `Authorization` (and by the fakes in
 * `@dads-framework/access/testing`). The kit never does permission math: the
 * decision table is the same pure `evaluateRouteAccess` the old guard used,
 * so denied checks keep surfacing as 404 (never leaking existence) and
 * missing subjects as 401.
 */
export type SubjectResolver = {
  resolve(request: {
    headers: Record<string, string | string[] | undefined>;
    readonly url?: string;
  }): Promise<SubjectRef | null>;
  /**
   * The same resolution, plus which credential answered. Optional on purpose:
   * a resolver that cannot say enforces exactly as before and simply reports
   * no method.
   */
  resolveWithMethod?(request: {
    headers: Record<string, string | string[] | undefined>;
    readonly url?: string;
  }): Promise<ResolvedSubject | null>;
};

export type PermissionChecker = {
  check(query: {
    subject: SubjectRef;
    permission: string;
    resource: { type: string; id: string };
  }): Promise<boolean>;
};

/** The set-question port `requireVisibility` and `requiresScoped` need (Authorization has it). */
export type VisibleResourceLookup = {
  lookupResources(query: {
    subject: SubjectRef;
    permission: string;
    resourceType: string;
  }): Promise<readonly string[]>;
};

/** Domain-owned context policy; the HTTP kit never constructs a business actor. */
export type AuthorizationContextResolver = {
  execute(
    authenticatedSubject: SubjectRef,
    requestedContext: unknown,
  ): Promise<{ readonly subject: SubjectRef } | null>;
};

/** A failed check, for server-side diagnostics — the wire stays a bare 404. */
export type AccessDenial = {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly permission: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly url: string | undefined;
  /** Which credential authenticated the denied caller, when the resolver says. */
  readonly authMethod?: AuthMethod;
};

export type AccessPorts = {
  readonly subjects: SubjectResolver;
  readonly authorization: PermissionChecker;
  /** Required only by requireVisibility and requiresScoped routes; the Authorization battery satisfies it. */
  readonly lookups?: VisibleResourceLookup;
  /** Required by routes explicitly declared with withAuthorizationContext. */
  readonly authorizationContexts?: AuthorizationContextResolver;
  /**
   * Denial breadcrumb (docs/architecture/authorization.md): fired when a
   * RESOLVED subject fails a check — the "you probably forgot the tuple or
   * typo'd the type string" signal. Never fired for 401s, never on allow.
   */
  readonly onDenied?: (denial: AccessDenial) => void;
};

/**
 * What the route handler does with an enforced request. The fields below
 * `visibleIds` are the settled decision, recorded downstream (the request log)
 * and read by nothing that decides: enforcement reports them, it never
 * consults them.
 */
export type AccessDecision =
  | {
      readonly outcome: "allow";
      readonly subject: SubjectRef | null;
      /** Login identity, never replaced by the selected business actor. */
      readonly authenticatedSubject: SubjectRef | null;
      readonly untrustedAuthorizationContext?: string;
      /** The context the resolver accepted, as the caller named it. One subject may answer several contexts, so the subject alone does not say which. */
      readonly authorizationContext?: string;
      /** Present exactly when the route declared requireVisibility. */
      readonly visibleIds?: readonly string[];
      /** Present exactly when the route declared requiresScoped. */
      readonly scope?: ScopeAnswer;
      /** Which access declaration answered this request. */
      readonly accessKind: RouteAccess["kind"];
      /** The settled permission — permission and visibility routes only. */
      readonly permission?: string;
      /** What the permission was checked against — permission routes only. */
      readonly resource?: { readonly type: string; readonly id: string };
      /** Which credential authenticated the caller, when the resolver says. */
      readonly authMethod?: AuthMethod;
      /** When the caller last signed in again on their session, when the resolver read one stamped so. */
      readonly sessionReauthenticatedAt?: Date;
    }
  /** Nobody proved who they are, so there is no one to name. */
  | { readonly outcome: "unauthenticated" }
  /**
   * Refused after a caller was resolved. The identities ride along for the
   * request log alone, so the refusal row names who was refused; the wire
   * stays a bare 404.
   */
  | {
      readonly outcome: "not-found";
      /** The business actor, or null when it never resolved (context refused). */
      readonly subject: SubjectRef | null;
      /** Login identity the credential proved. */
      readonly authenticatedSubject: SubjectRef | null;
    };

type AllowDecision = Extract<AccessDecision, { outcome: "allow" }>;
type NotFoundDecision = Extract<AccessDecision, { outcome: "not-found" }>;

/** One construction site for allows, so no path can forget a breadcrumb. */
function allow(decision: Omit<AllowDecision, "outcome">): AllowDecision {
  return { outcome: "allow", ...decision };
}

/** One construction site for refusals, so no path can drop who was refused. */
function notFound(
  subject: SubjectRef | null,
  authenticatedSubject: SubjectRef | null,
): NotFoundDecision {
  return {
    outcome: "not-found",
    subject,
    authenticatedSubject,
  };
}

/**
 * What the resolver said about the caller beyond who they are. Each fact is
 * present only when the resolver stated it; an absent fact is left out, never
 * written as `undefined`.
 */
function callerFacts(
  caller: AuthenticatedCaller,
): Pick<AllowDecision, "authMethod" | "sessionReauthenticatedAt"> {
  return {
    ...(caller.authMethod === undefined
      ? {}
      : { authMethod: caller.authMethod }),
    ...(caller.sessionReauthenticatedAt === undefined
      ? {}
      : { sessionReauthenticatedAt: caller.sessionReauthenticatedAt }),
  };
}

type EnforceableRequest = {
  readonly headers: Record<string, string | string[] | undefined>;
  /** Original occurrences let enforcement detect duplicate headers even after joining. */
  readonly raw?: { readonly rawHeaders: readonly string[] };
  readonly params: unknown;
  /** Fastify's parsed body — read RAW here (enforcement precedes Zod). */
  readonly body?: unknown;
  /** Fastify's parsed query — read RAW here (enforcement precedes Zod). */
  readonly query?: unknown;
  readonly url?: string;
};

/** The authenticated caller, with the credential named when the port can. */
type AuthenticatedCaller = {
  readonly subject: SubjectRef;
  readonly authMethod: AuthMethod | undefined;
  /** When the caller last signed in again on their session, when the resolver read one stamped so. */
  readonly sessionReauthenticatedAt: Date | undefined;
};

/**
 * Prefer the widened port; fall back to the narrow one. A resolver that
 * implements `resolveWithMethod` owns the answer outright — a null from it is
 * "nobody", never a reason to ask `resolve` for a second opinion.
 */
async function resolveAuthenticatedCaller(
  request: EnforceableRequest,
  ports: AccessPorts,
): Promise<AuthenticatedCaller | null> {
  const reported = await ports.subjects.resolveWithMethod?.(request);
  if (reported !== undefined) {
    return reported === null
      ? null
      : {
          subject: reported.subject,
          authMethod: reported.method,
          sessionReauthenticatedAt: reported.sessionReauthenticatedAt,
        };
  }
  const subject = await ports.subjects.resolve(request);
  return subject === null
    ? null
    : {
        subject,
        authMethod: undefined,
        sessionReauthenticatedAt: undefined,
      };
}

async function resolveRequestSubjects(
  access: RouteAccess,
  request: EnforceableRequest,
  ports: AccessPorts,
): Promise<AccessDecision> {
  const accessKind = access.kind;
  if (access.kind === "public") {
    return allow({ subject: null, authenticatedSubject: null, accessKind });
  }
  const caller = await resolveAuthenticatedCaller(request, ports);
  if (caller === null) return { outcome: "unauthenticated" };
  const { subject: authenticatedSubject } = caller;
  if (authenticatedSubject.type === "facilities/edge_device") {
    return allow({
      subject: authenticatedSubject,
      authenticatedSubject,
      accessKind,
      ...callerFacts(caller),
    });
  }
  if (access.authorizationContext === undefined) {
    return retainAuthenticatedSubject(access, request, caller);
  }
  if (
    access.authorizationContextMode === "technical-or-business" &&
    isTechnicalContextAbsent(access.authorizationContext, request)
  ) {
    return allow({
      subject: authenticatedSubject,
      authenticatedSubject,
      accessKind,
      ...callerFacts(caller),
    });
  }
  return resolveBusinessActor(
    access.authorizationContext,
    request,
    caller,
    ports,
    accessKind,
  );
}

/**
 * The business actor the requested authorization context names. A refusal
 * here still names the login identity, so the request row records who asked.
 */
async function resolveBusinessActor(
  source: ResourceIdSource,
  request: EnforceableRequest,
  caller: AuthenticatedCaller,
  ports: AccessPorts,
  accessKind: RouteAccess["kind"],
): Promise<AccessDecision> {
  const { subject: authenticatedSubject } = caller;
  if (ports.authorizationContexts === undefined) {
    throw new HttpWiringError(
      "authorization-context route registered without a resolver",
    );
  }
  const requestedContext = resolveResourceId(source, request);
  if (requestedContext === undefined) {
    return notFound(null, authenticatedSubject);
  }
  const authorizationContext = await ports.authorizationContexts.execute(
    authenticatedSubject,
    requestedContext,
  );
  if (authorizationContext === null) {
    return notFound(null, authenticatedSubject);
  }
  return allow({
    subject: authorizationContext.subject,
    authenticatedSubject,
    authorizationContext: requestedContext,
    accessKind,
    ...callerFacts(caller),
  });
}

/** Input-only routes retain identity; their domain resolves the explicit purpose. */
function retainAuthenticatedSubject(
  access: RouteAccess,
  request: EnforceableRequest,
  caller: AuthenticatedCaller,
): AccessDecision {
  const inputSource =
    access.kind === "session" ? access.authorizationContextInput : undefined;
  const input =
    inputSource === undefined
      ? undefined
      : resolveResourceId(inputSource, request);
  if (
    inputSource?.kind === "header" &&
    input === undefined &&
    request.headers[inputSource.name.toLowerCase()] !== undefined
  )
    return notFound(caller.subject, caller.subject);
  return allow({
    subject: caller.subject,
    authenticatedSubject: caller.subject,
    accessKind: access.kind,
    ...callerFacts(caller),
    ...(input === undefined ? {} : { untrustedAuthorizationContext: input }),
  });
}

function buildVerdictInput(
  access: RouteAccess,
  request: EnforceableRequest,
  subject: SubjectRef | null,
): RouteAccessInput {
  return {
    isPublic: access.kind === "public",
    sessionOnly: access.kind === "session",
    permission:
      access.kind === "permission"
        ? {
            resourceType: access.resourceType,
            permission: access.permission,
            source: access.resourceId,
          }
        : undefined,
    subject,
    resourceId:
      access.kind === "permission"
        ? resolveResourceId(access.resourceId, request)
        : undefined,
  };
}

async function settleCheck(
  input: RouteAccessInput,
  verdict: Extract<RouteAccessVerdict, { outcome: "check" }>,
  subject: SubjectRef,
  authorization: PermissionChecker,
): Promise<RouteAccessVerdict> {
  const checkResult = await authorization.check({
    subject,
    permission: verdict.permission,
    resource: verdict.resource,
  });
  return evaluateRouteAccess({ ...input, checkResult });
}

function toDecision(
  verdict: RouteAccessVerdict,
  subjects: Extract<AccessDecision, { outcome: "allow" }>,
): AccessDecision {
  switch (verdict.outcome) {
    case "allow":
      return subjects;
    case "unauthenticated":
      return { outcome: "unauthenticated" };
    case "not-found":
      return notFound(subjects.subject, subjects.authenticatedSubject);
    case "check":
      // Impossible: settleCheck resolved it above; fail closed regardless.
      return notFound(subjects.subject, subjects.authenticatedSubject);
  }
}

/**
 * Enforces a route's `access` declaration: resolve the subject, evaluate
 * the pure decision table, check the business permission after any required
 * authorization-context resolution, and hand
 * back exactly what the caller may do. A `scoped` route passes the plan
 * `registerRoutes` compiled for it at registration.
 */
export async function enforceAccess(
  access: RouteAccess,
  request: EnforceableRequest,
  ports: AccessPorts,
  scopePlan?: ScopePlan,
): Promise<AccessDecision> {
  const subjects = await resolveRequestSubjects(access, request, ports);
  if (subjects.outcome !== "allow") return subjects;
  if (access.kind === "visibility") {
    return enforceVisibility(access, subjects, ports);
  }
  if (access.kind === "scoped") {
    return enforceScope(access, subjects, ports, scopePlan);
  }
  const subject = subjects.subject;
  const input = buildVerdictInput(access, request, subject);
  let verdict = evaluateRouteAccess(input);
  if (verdict.outcome === "check") {
    if (subject === null) return { outcome: "unauthenticated" };
    const resource = verdict.resource;
    const permission = verdict.permission;
    verdict = await settleCheck(input, verdict, subject, ports.authorization);
    if (verdict.outcome === "not-found") {
      ports.onDenied?.({
        subjectType: subject.type,
        subjectId: subject.id,
        permission,
        resourceType: resource.type,
        resourceId: resource.id,
        url: request.url,
        ...(subjects.authMethod === undefined
          ? {}
          : { authMethod: subjects.authMethod }),
      });
    }
    if (verdict.outcome === "allow") {
      return { ...subjects, permission, resource };
    }
  }
  return toDecision(verdict, subjects);
}

/**
 * The set question, handled apart from the boolean table: resolve the
 * subject (401 without one), ask lookupResources, allow with the visible
 * set. An empty set is a VALID allow — the list verb short-circuits it to
 * an empty page without running the handler (fail-closed by construction).
 */
async function enforceVisibility(
  access: Extract<RouteAccess, { kind: "visibility" }>,
  subjects: Extract<AccessDecision, { outcome: "allow" }>,
  ports: AccessPorts,
): Promise<AccessDecision> {
  const subject = subjects.subject;
  if (subject === null) {
    return { outcome: "unauthenticated" };
  }
  if (!ports.lookups) {
    // Wired wrong (a visibility route without a lookup port) — loud 500.
    throw new HttpWiringError(
      "requireVisibility route registered without a lookups port",
    );
  }
  const visibleIds = await ports.lookups.lookupResources({
    subject,
    permission: access.permission,
    resourceType: access.resourceType,
  });
  // A set question settles a permission but no single resource, so only the
  // permission is reported.
  return { ...subjects, visibleIds, permission: access.permission };
}
