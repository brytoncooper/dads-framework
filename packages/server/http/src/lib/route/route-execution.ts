import type { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";
import type { HttpMethod, RouteContract } from "@dads-framework/contract";

import {
  HttpWiringError,
  type RequestPart,
  RequestValidationError,
  ResponseDriftError,
} from "../http-errors.js";
import { isObjectValue } from "../object-value.js";
import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";
import type {
  RawRouteInput,
  RouteBlueprint,
  RouteHandlerContext,
  RouteResult,
} from "./route-definition.js";

/**
 * The type-erased view verb builders hand to route execution. Public verb
 * signatures preserve their exact handler context; method syntax retains the
 * sanctioned bivariance required at this erased boundary.
 */
export type ErasedRouteConfig = {
  readonly descriptor: RouteContract;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly capabilities?: RouteCapabilities;
  readonly access: RouteAccess;
  readonly response: z.ZodType;
  readonly meta?: z.ZodType;
  readonly status?: 200 | 201 | 202;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  handler(
    context: RouteHandlerContext<unknown, unknown, unknown, SubjectRef>,
  ): unknown;
};

/** Erased form of a no-content (DELETE) route. */
export type ErasedNoContentConfig = {
  readonly descriptor: RouteContract;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly capabilities?: RouteCapabilities;
  readonly access: RouteAccess;
  readonly params?: z.ZodType;
  readonly body?: z.ZodType;
  handler(
    context: RouteHandlerContext<unknown, undefined, unknown, SubjectRef>,
  ): Promise<void> | void;
};

/** The execution engine behind response-producing route verbs. */
export function buildDefinition(config: ErasedRouteConfig): RouteBlueprint {
  const status = config.status ?? (config.method === "POST" ? 201 : 200);

  const execute = async (raw: RawRouteInput): Promise<RouteResult> => {
    const subject = raw.subject;
    assertSubjectAllowed(config, subject);
    const authenticatedSubject = resolveAuthenticatedSubject(
      config.access,
      raw,
    );
    assertSubjectAllowed(config, authenticatedSubject);
    const inputs = parseInputs(config, raw);
    const result = await config.handler({
      ...inputs,
      subject,
      authenticatedSubject,
      requestId: raw.requestId,
      locale: raw.locale,
      log: raw.log,
      ...forwardedIdentity(raw),
      ...forwardedReads(raw),
    });
    return parseHandlerResult(config, result);
  };

  return {
    kind: "route",
    descriptor: config.descriptor,
    method: config.method,
    path: config.path,
    summary: config.summary,
    ...bodyLimitOf(config),
    access: config.access,
    capabilities: config.capabilities ?? {},
    status,
    schemas: { response: config.response, ...requestSchemasOf(config) },
    execute,
  };
}

/** The execution engine behind deleteRoute: parse inputs, then return 204. */
export function buildNoContentDefinition(
  config: ErasedNoContentConfig,
): RouteBlueprint {
  const execute = async (raw: RawRouteInput): Promise<RouteResult> => {
    const subject = raw.subject;
    assertSubjectAllowed(config, subject);
    const authenticatedSubject = resolveAuthenticatedSubject(
      config.access,
      raw,
    );
    assertSubjectAllowed(config, authenticatedSubject);
    const inputs = parseInputs(config, raw);
    await config.handler({
      params: inputs.params,
      query: undefined,
      body: inputs.body,
      subject,
      authenticatedSubject,
      requestId: raw.requestId,
      locale: raw.locale,
      log: raw.log,
      ...forwardedIdentity(raw),
    });
    return { data: undefined };
  };

  return {
    kind: "route",
    descriptor: config.descriptor,
    method: config.method,
    path: config.path,
    summary: config.summary,
    ...bodyLimitOf(config),
    access: config.access,
    capabilities: config.capabilities ?? {},
    status: 204,
    schemas: requestSchemasOf(config),
    execute,
  };
}

type HandlerContext = RouteHandlerContext<
  unknown,
  unknown,
  unknown,
  SubjectRef
>;

/** Who the caller is beyond the subject, each part only when enforcement set it. */
function forwardedIdentity(
  raw: RawRouteInput,
): Pick<
  HandlerContext,
  | "untrustedAuthorizationContext"
  | "authorizationContext"
  | "sessionReauthenticatedAt"
> {
  return {
    ...(raw.untrustedAuthorizationContext === undefined
      ? {}
      : { untrustedAuthorizationContext: raw.untrustedAuthorizationContext }),
    ...(raw.authorizationContext === undefined
      ? {}
      : { authorizationContext: raw.authorizationContext }),
    ...(raw.sessionReauthenticatedAt === undefined
      ? {}
      : { sessionReauthenticatedAt: raw.sessionReauthenticatedAt }),
  };
}

/** What a visibility, scoped or feature-state route was given to read with. */
function forwardedReads(
  raw: RawRouteInput,
): Pick<HandlerContext, "visibleIds" | "scope" | "featureState"> {
  return {
    ...(raw.visibleIds === undefined ? {} : { visibleIds: raw.visibleIds }),
    ...(raw.scope === undefined ? {} : { scope: raw.scope }),
    ...(raw.featureState === undefined
      ? {}
      : { featureState: raw.featureState }),
  };
}

function bodyLimitOf(config: { readonly bodyLimitBytes?: number }): {
  bodyLimitBytes?: number;
} {
  return config.bodyLimitBytes === undefined
    ? {}
    : { bodyLimitBytes: config.bodyLimitBytes };
}

/** The request schemas a route declared; an undeclared part stays absent. */
function requestSchemasOf(config: {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly meta?: z.ZodType;
}): RouteBlueprint["schemas"] {
  return {
    ...(config.params === undefined ? {} : { params: config.params }),
    ...(config.query === undefined ? {} : { query: config.query }),
    ...(config.body === undefined ? {} : { body: config.body }),
    ...(config.meta === undefined ? {} : { meta: config.meta }),
  };
}

function resolveAuthenticatedSubject(
  access: RouteAccess,
  raw: RawRouteInput,
): SubjectRef | null {
  if (access.kind !== "public" && access.authorizationContext !== undefined) {
    if (
      raw.authenticatedSubject === undefined ||
      raw.authenticatedSubject === null
    ) {
      throw new HttpWiringError(
        "authorization-context route ran without its authenticated identity",
      );
    }
    return raw.authenticatedSubject;
  }
  return raw.authenticatedSubject ?? raw.subject;
}

function parseInputs(
  config: {
    params?: z.ZodType;
    query?: z.ZodType;
    body?: z.ZodType;
  },
  raw: RawRouteInput,
): { params: unknown; query: unknown; body: unknown } {
  return {
    params: parsePart("params", config.params, raw.params),
    query: parsePart("query", config.query, raw.query),
    body: parsePart("body", config.body, raw.body),
  };
}

function parsePart(
  part: RequestPart,
  schema: z.ZodType | undefined,
  raw: unknown,
): unknown {
  if (schema === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new RequestValidationError(part, parsed.error);
  }
  return parsed.data;
}

function assertSubjectAllowed(
  route: { method: string; path: string; access: RouteAccess },
  subject: SubjectRef | null,
): asserts subject is SubjectRef {
  if (route.access.kind !== "public" && subject === null) {
    throw new HttpWiringError(
      `route ${route.method} ${route.path} ran without a subject despite ${route.access.kind} access`,
    );
  }
}

function parseHandlerResult(
  config: ErasedRouteConfig,
  raw: unknown,
): RouteResult {
  if (config.meta === undefined) {
    return { data: parseHalf(config.path, config.response, raw) };
  }
  if (!isObjectValue(raw) || !("data" in raw) || !("meta" in raw)) {
    throw new HttpWiringError(
      `route ${config.method} ${config.path} declares a meta schema but its handler did not return { data, meta }`,
    );
  }
  return {
    data: parseHalf(config.path, config.response, raw["data"]),
    meta: parseHalf(config.path, config.meta, raw["meta"]),
  };
}

function parseHalf(
  routePath: string,
  schema: z.ZodType,
  candidate: unknown,
): unknown {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ResponseDriftError(routePath, parsed.error);
  }
  return parsed.data;
}
