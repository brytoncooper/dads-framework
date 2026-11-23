import type { AccessModel } from "@dads-framework/access";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";

import { answeringEachQuestionOnce } from "@dads-framework/core/runtime/request-work";
import { ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE } from "@dads-framework/core/contract";

import { HttpWiringError } from "../http-errors.js";
import { rememberAccessOutcome } from "../request-log/request-outcome.js";
import type { RouteCapabilities } from "../route/capabilities.js";
import type { RawRouteDefinition } from "../route/define-raw-route.js";
import type { RouteDefinition } from "../route/route-definition.js";
import type { HttpRoute } from "../route/route-group.js";
import { assertNoAppSiteServing } from "./assert-no-app-site-serving.js";
import { type AuditActorForSubject, carryResolvedAuditActor, rememberRefusedAuditActor } from "./carry-audit-actor.js";
import {
  attachWrittenAuthorizationConsistencyCookie,
  carryAuthorizationConsistency,
} from "./carry-authorization-consistency.js";
import {
  type AccessDecision,
  type AccessPorts,
  enforceAccess,
  resolveLookupsPort,
  type SubjectResolver,
  type VisibleResourceLookup,
} from "./enforce-access.js";
import { compileRouteScopePlan } from "./enforce-scope.js";
import { envelope } from "./envelope.js";
import {
  assertFeatureStateWriteIsCurrent,
  featureStateContext,
  type FeatureStateProtocol,
  type FeatureStateSnapshot,
  resolveFeatureState,
  writeFeatureStateHash,
} from "./feature-state.js";
import { carryFeatureStatePreview } from "./feature-state-preview.js";
import { isWriteMethod } from "./logic/is-write-method.js";
import { assertNoAppMachineCredential, routeOptionsFor } from "./machine-credential-access.js";
import type { RateLimiter } from "./rate-limit.js";
import { parseBodyAsBytes } from "./raw-route-byte-body.js";
import { requestIdOf } from "./request-id.js";
import { addRequestLanguageVaryHeader } from "./request-language-response.js";
import { consumeBudget, limiterFor, sendRateLimited } from "./route-rate-limit.js";
import { runRoute } from "./run-route.js";

export type RegisterRoutesOptions = AccessPorts & {
  readonly routes: readonly HttpRoute[];
  /** Required when a route declares list visibility or scope access. */
  readonly accessModel?: AccessModel;
  /** App rung of the capability ladder (route > group > app). */
  readonly capabilities?: RouteCapabilities;
  /**
   * Hard deadline for a route's handler. Node's `requestTimeout` only bounds
   * receiving the request from a slow client — nothing built-in stops a hung
   * handler from pinning its socket, so the kit races every execute against
   * this. A number, never disable-able. Default 30s.
   */
  readonly handlerTimeoutMs?: number;
  /**
   * Turns an allowed request's subject into the audit actor its writes are
   * recorded under. The composition root passes what
   * `composeSubjectToAuditActor` from `@dads-framework/audit` built for its own
   * subject kinds; without it the handler keeps the ingress `anonymous`
   * context — writes still succeed, they are just attributed to nobody.
   */
  readonly auditActorForSubject?: AuditActorForSubject;
  /**
   * Optional application evaluator and the header names its clients speak; the
   * kit owns the once-per-request protocol. Omitted, no snapshot is resolved
   * and no hash header is written.
   */
  readonly featureState?: FeatureStateProtocol;
  /**
   * Named machine-credential resolvers. A route declaring
   * `capabilities.machineCredential: name` resolves its caller only through
   * `machineCredentials[name]` (never `subjects`); every other route never
   * consults these. A declared name without a resolver throws at registration.
   */
  readonly machineCredentials?: Readonly<Record<string, SubjectResolver>>;
};

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

function sendAccessRefusal(reply: FastifyReply, decision: Exclude<AccessDecision, { outcome: "allow" }>): FastifyReply {
  if (decision.outcome === "unauthenticated") {
    return reply.status(401).send({
      error: { code: "NOT_AUTHENTICATED", message: "Authentication required" },
    });
  }
  // The body stays the bare not-found envelope; only the header says the
  // edge refused. The edge answers the same for a missing record as for one
  // the caller may not reach, so the mark reveals nothing about existence.
  return reply
    .status(404)
    .header(ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE)
    .send({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource not found" },
    });
}

/** What both handlers need once access has said yes. */
type AllowedRequest = {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly decision: Extract<AccessDecision, { outcome: "allow" }>;
  readonly limiter: RateLimiter | null;
  readonly featureState: FeatureStateProtocol | undefined;
};

/**
 * The per-request scopes every route runs inside: the authorization
 * consistency cookie, and one memory of authorization answers so the edge
 * check and the handler's own identical check reach SpiceDB once. Both end
 * with the request; neither is ever shared between requests.
 */
function carryRequestScopes<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
  return carryAuthorizationConsistency(request, () => answeringEachQuestionOnce(work));
}

/** enforce access → become the caller → feature preview → feature state → consume budget → run the pipeline → envelope. */
function buildRouteHandler(
  definition: RouteDefinition,
  options: RegisterRoutesOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  const timeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const limiter = limiterFor(definition, options.capabilities);
  const scopePlan = compileRouteScopePlan(definition, options.accessModel);
  return async (request, reply) =>
    carryRequestScopes(request, async () => {
      const decision = await enforceAccess(definition.access, request, options, scopePlan);
      rememberAccessOutcome(request, definition.access, decision);
      if (decision.outcome !== "allow") {
        rememberRefusedAuditActor(options.auditActorForSubject, request, decision);
        return sendAccessRefusal(reply, decision);
      }
      const allowed: AllowedRequest = {
        request,
        reply,
        decision,
        limiter,
        featureState: options.featureState,
      };
      return carryResolvedAuditActor(options.auditActorForSubject, request, decision, () =>
        answerTypedRouteInPreview(definition, allowed, timeoutMs),
      );
    });
}

function answerTypedRouteInPreview(
  definition: RouteDefinition,
  allowed: AllowedRequest,
  timeoutMs: number,
): Promise<FastifyReply> {
  return withFeaturePreview(definition, allowed, () => answerTypedRoute(definition, allowed, timeoutMs));
}

async function answerTypedRoute(
  definition: RouteDefinition,
  allowed: AllowedRequest,
  timeoutMs: number,
): Promise<FastifyReply> {
  const { request, reply, decision } = allowed;
  const featureState = await resolveAndWriteFeatureState(definition, allowed);
  const budget = consumeBudget(allowed.limiter, definition, request, decision.authenticatedSubject?.id);
  if (!budget.allowed) {
    return sendRateLimited(request, reply, budget.retryAfterSeconds);
  }
  const result = await runRoute(definition, request, decision, timeoutMs, featureState ?? undefined);
  await refreshFeatureStateHashAfterWrite(definition, allowed);
  if (definition.status === 204) {
    return reply.status(204).send();
  }
  return reply.status(definition.status).send(envelope(result.data, result.meta));
}

/** enforce access → become the caller → hand the request to the raw handler. No envelope, no deadline. */
function buildRawHandler(
  definition: RawRouteDefinition,
  options: RegisterRoutesOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const limiter = limiterFor(definition, options.capabilities);
  compileRouteScopePlan(definition, options.accessModel);
  return async (request, reply) =>
    carryRequestScopes(request, async () => {
      const decision = await enforceAccess(definition.access, request, options);
      rememberAccessOutcome(request, definition.access, decision);
      if (decision.outcome !== "allow") {
        rememberRefusedAuditActor(options.auditActorForSubject, request, decision);
        sendAccessRefusal(reply, decision);
        return;
      }
      const allowed: AllowedRequest = {
        request,
        reply,
        decision,
        limiter,
        featureState: options.featureState,
      };
      await carryResolvedAuditActor(options.auditActorForSubject, request, decision, () =>
        answerRawRouteInPreview(definition, allowed),
      );
    });
}

function answerRawRouteInPreview(definition: RawRouteDefinition, allowed: AllowedRequest): Promise<void> {
  return withFeaturePreview(definition, allowed, () => answerRawRoute(definition, allowed));
}

async function answerRawRoute(definition: RawRouteDefinition, allowed: AllowedRequest): Promise<void> {
  const { request, reply, decision } = allowed;
  await resolveAndWriteFeatureState(definition, allowed);
  const budget = consumeBudget(allowed.limiter, definition, request, decision.authenticatedSubject?.id);
  if (!budget.allowed) {
    sendRateLimited(request, reply, budget.retryAfterSeconds);
    return;
  }
  await definition.handler({
    request,
    reply,
    subject: decision.subject,
    authenticatedSubject: decision.authenticatedSubject,
    requestId: requestIdOf(request),
    log: request.log,
  });
  await refreshFeatureStateHashAfterWrite(definition, allowed);
}

/** Refuses a write the route does not allow while a staff member is signed in as the user. */

/** Runs `work` inside the caller's feature preview, when the request carries a live one. */
function withFeaturePreview<T>(definition: HttpRoute, allowed: AllowedRequest, work: () => Promise<T>): Promise<T> {
  return carryFeatureStatePreview({
    protocol: allowed.featureState?.preview,
    request: allowed.request,
    reply: allowed.reply,
    authenticatedSubject: allowed.decision.authenticatedSubject,
    subject: allowed.decision.subject,
    context: featureStateContext(allowed.featureState, allowed.request),
    method: definition.method,
    writesDuringFeaturePreview: definition.capabilities.writesDuringFeaturePreview,
    work,
  });
}

async function resolveAndWriteFeatureState(
  definition: HttpRoute,
  allowed: AllowedRequest,
): Promise<FeatureStateSnapshot | null> {
  const protocol = allowed.featureState;
  if (protocol === undefined) return null;
  const featureState = await resolveFeatureState({
    protocol,
    request: allowed.request,
    authenticatedSubject: allowed.decision.authenticatedSubject,
    subject: allowed.decision.subject,
  });
  writeFeatureStateHash(allowed.reply, protocol.hashHeader, featureState);
  assertFeatureStateWriteIsCurrent({
    snapshot: featureState,
    clientHashHeader: protocol.clientHashHeader,
    request: allowed.request,
    method: definition.method,
    featureStateWrite: definition.capabilities.featureStateWrite,
  });
  return featureState;
}

async function refreshFeatureStateHashAfterWrite(definition: HttpRoute, allowed: AllowedRequest): Promise<void> {
  const protocol = allowed.featureState;
  if (protocol === undefined || !isWriteMethod(definition.method)) return;
  const postWriteFeatureState = await resolveFeatureState({
    protocol,
    request: allowed.request,
    authenticatedSubject: allowed.decision.authenticatedSubject,
    subject: allowed.decision.subject,
  });
  writeFeatureStateHash(allowed.reply, protocol.hashHeader, postWriteFeatureState);
}

function toFastifyRoute(definition: HttpRoute, options: RegisterRoutesOptions): RouteOptions {
  return {
    method: definition.method,
    url: definition.path,
    // Typed verbs and raw routes alike: omitted keeps the app's limit.
    ...(definition.bodyLimitBytes === undefined ? {} : { bodyLimit: definition.bodyLimitBytes }),
    // The early pass reaches hijacked raw/SSE sockets. The send-time pass
    // merges fields a non-hijacked route added while producing its response.
    onRequest: (request, reply, done) => {
      addRequestLanguageVaryHeader(reply);
      // Before Fastify picks the body parser, so only this route is affected.
      if (definition.kind === "raw-route" && definition.bodyAsBytes === true) {
        parseBodyAsBytes(request);
      }
      done();
    },
    onSend: (request, reply, payload, done) => {
      addRequestLanguageVaryHeader(reply);
      attachWrittenAuthorizationConsistencyCookie(request, reply);
      done(null, payload);
    },
    handler:
      definition.kind === "raw-route" ? buildRawHandler(definition, options) : buildRouteHandler(definition, options),
  };
}

function assertLookupsPortForRoute(definition: HttpRoute, lookups: VisibleResourceLookup | undefined): void {
  if (lookups !== undefined) {
    return;
  }
  if (definition.access.kind === "visibility") {
    throw new HttpWiringError(`${definition.method} ${definition.path} uses requiresVisible without a lookups port`);
  }
  if (definition.access.kind === "scoped") {
    throw new HttpWiringError(`${definition.method} ${definition.path} uses requiresScoped without a lookups port`);
  }
}

/**
 * Compiles a route table onto a Fastify instance. Each handler reads as the
 * composition it is: `enforceAccess` → `runRoute` (parse → handler → parse,
 * under `withDeadline`) → `envelope`. Failures propagate to the kit error
 * handler — nothing here invents statuses beyond the access refusals.
 */
export function registerRoutes(app: FastifyInstance, options: RegisterRoutesOptions): void {
  assertNoAppMachineCredential(options.capabilities);
  assertNoAppSiteServing(options.capabilities);
  const lookups = resolveLookupsPort(options);
  const effectiveOptions: RegisterRoutesOptions = lookups === undefined ? options : { ...options, lookups };
  for (const definition of effectiveOptions.routes) {
    assertLookupsPortForRoute(definition, lookups);
    app.route(toFastifyRoute(definition, routeOptionsFor(definition, effectiveOptions)));
  }
}
