import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";
import type { HttpMethod, RouteLogger } from "./route-definition.js";

/**
 * The kit's ONE sanctioned escape hatch — for responses the typed verbs
 * cannot express: SSE, streamed downloads, multipart. The bar for using it
 * (docs/architecture/http-edge.md): the kit can't express what you need AND
 * growing the kit was considered first. Raw routes still declare `access`
 * (enforced identically — denied checks are 404, anonymous is 401) and
 * still flow through the error envelope if they throw before streaming.
 *
 * Deliberately NOT under the handler deadline: streams are legitimately
 * long-lived. A raw route owns its own lifetime and backpressure.
 */

/** What a raw handler receives — Fastify surfaces on purpose, only here. */
export type RawRouteContext = {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly subject: SubjectRef | null;
  /** Real account identity for audit and user-owned operations. */
  readonly authenticatedSubject: SubjectRef | null;
  readonly requestId: string;
  readonly log: RouteLogger;
};

/**
 * Hand-declared OpenAPI operation body for this route — the one exception
 * to generated-only, marked `x-raw-route: true` in the artifact so contract
 * review can see it.
 */
export type RawOpenApiOperation = Record<string, unknown>;

/**
 * Contract schemas the hand-declared operation points at by `$ref`, keyed by
 * component name. The builder converts them exactly as it converts a typed
 * verb's schemas, so a raw route that answers JSON still documents ONE shape
 * source instead of a hand-written body (docs/architecture/api-documentation.md).
 * Without this, a `$ref` a raw route names is a dangling pointer — nothing else
 * registers it.
 */
export type RawOpenApiComponents = Readonly<Record<string, z.ZodType>>;

export type RawRouteConfig = {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly access: RouteAccess;
  /** Route-rung of the capability ladder (route > group > app). */
  readonly capabilities?: RouteCapabilities;
  /**
   * Maximum request body bytes for this route; omitted retains the
   * application limit. Only a route whose body type the app agreed to
   * receive (`rawBodyContentTypes`, `byteBodyContentTypes`) gets a body at all.
   */
  readonly bodyLimitBytes?: number;
  /**
   * Receive the body as the exact bytes (a `Buffer`) whatever `Content-Type`
   * the client sent, `application/json` and `text/plain` included: this
   * route's requests are parsed as `application/octet-stream` and the sent
   * type stays readable through `contentTypeSentWithBytes`. For a route that
   * stores a file's bytes as a browser sends them. Still needs the app to
   * name a byte parser (`byteBodyContentTypes`); without one the route
   * answers 415.
   */
  readonly bodyAsBytes?: boolean;
  readonly openapi: RawOpenApiOperation;
  /** Component schemas the `openapi` block refs; omit for byte-stream routes. */
  readonly openapiComponents?: RawOpenApiComponents;
  readonly handler: (ctx: RawRouteContext) => Promise<void>;
};

/** A raw route before grouping — unregistrable until routeGroup stamps it. */
export type RawRouteBlueprint = RawRouteConfig & {
  readonly kind: "raw-route";
};

export type RawRouteDefinition = RawRouteBlueprint & {
  readonly tag: string;
  readonly capabilities: RouteCapabilities;
};

/** Declare a raw route. `access` is required — same wall as every verb. */
export function defineRawRoute(config: RawRouteConfig): RawRouteBlueprint {
  return { ...config, kind: "raw-route" };
}
