import type { z } from "zod";

import type { ScopeAnswer, SubjectRef } from "@dads-framework/access/runtime";
import type {
  HttpMethod,
  Locale,
  RouteContract,
} from "@dads-framework/core/contract";

import { HttpWiringError } from "../http-errors.js";
import type { FeatureStateSnapshot } from "../request-pipeline/feature-state.js";
import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";

export type { HttpMethod } from "@dads-framework/core/contract";

/**
 * `:param` names extracted from a path template at the type level, so a
 * `params` schema that doesn't match the path fails to compile.
 */
export type PathParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

/** The object shape a `params` schema must produce for a given path. */
export type PathParamsShape<Path extends string> = Record<
  PathParamNames<Path>,
  string
>;

/**
 * Minimal structural logger (pino-compatible). Handlers never see Fastify —
 * this is the only logging surface they get.
 */
export type RouteLogger = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

/** What a handler receives: parsed inputs, the subject, and nothing else. */
export type RouteHandlerContext<Params, Query, Body, Subject> = {
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
  readonly subject: Subject;
  /** Authenticated account for audit; subject may be a company-qualified actor. */
  readonly authenticatedSubject: Subject;
  /** Captured input, not a resolved identity or proof of authority. Present only on input-only session routes. */
  readonly untrustedAuthorizationContext?: string;
  /**
   * The context `subject` was resolved for, as the caller named it. Present
   * only once a declared authorization context resolved. One subject may
   * answer several contexts, so the subject alone does not say which.
   */
  readonly authorizationContext?: string;
  /**
   * When the caller last proved who they are on their session, by a sign-in
   * the server forced and checked itself. Present only when the subject
   * resolver read a session stamped so; a write that asks for a recent
   * sign-in refuses without it.
   */
  readonly sessionReauthenticatedAt?: Date;
  readonly requestId: string;
  /**
   * The language this request asked for, resolved from `Accept-Language` with
   * an English fallback. Server-owned vocabulary is stored side by side and
   * resolved against this, so the wire keeps carrying plain strings.
   */
  readonly locale: Locale;
  readonly log: RouteLogger;
  /**
   * The subject's visible set — present exactly on requireVisibility list
   * routes (whose typed overload requires it); absent everywhere else.
   */
  readonly visibleIds?: readonly string[];
  /**
   * The subject's scope answers — present exactly on `requiresScoped` list
   * routes (whose typed overload requires it); absent everywhere else.
   */
  readonly scope?: ScopeAnswer;
  /** Request-scoped feature snapshot, present only on participating API routes. */
  readonly featureState?: FeatureStateSnapshot;
};

/**
 * A named route handler with no receiver. Generated handler bundles expose
 * these as readonly properties, so route cards can pass a direct reference.
 */
export type NamedRouteHandler<Context, Result> = (context: Context) => Result;

/** A named route handler whose implementation completes asynchronously. */
export type AsyncNamedRouteHandler<Context, Result> = NamedRouteHandler<
  Context,
  Promise<Result>
>;

export type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : undefined;

/**
 * What a handler must return: the data shape alone, or `{ data, meta }`
 * when the route declares a `meta` schema (paginated lists per
 * docs/architecture/api-conventions.md#pagination).
 */
export type HandlerResult<
  ResponseSchema extends z.ZodType,
  MetaSchema extends z.ZodType | undefined,
> = MetaSchema extends z.ZodType
  ? { data: z.input<ResponseSchema>; meta: z.input<MetaSchema> }
  : z.input<ResponseSchema>;

/** The raw material the kit feeds a route; `execute` does the typed work. */
export type RawRouteInput = {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly subject: SubjectRef | null;
  /** The pipeline always supplies this; direct identity-context execution may omit it. */
  readonly authenticatedSubject?: SubjectRef | null;
  readonly untrustedAuthorizationContext?: string;
  readonly authorizationContext?: string;
  /** When the caller last signed in again on their session, when the subject resolver says. */
  readonly sessionReauthenticatedAt?: Date;
  readonly requestId: string;
  readonly locale: Locale;
  readonly log: RouteLogger;
  /** Set by access enforcement on requireVisibility routes only. */
  readonly visibleIds?: readonly string[];
  /** Set by access enforcement on requiresScoped routes only. */
  readonly scope?: ScopeAnswer;
  readonly featureState?: FeatureStateSnapshot;
};

/** What `execute` hands back for enveloping — both halves schema-parsed. */
export type RouteResult = {
  readonly data: unknown;
  readonly meta?: unknown;
};

/** Public ingestion that appends internal records and creates no caller-owned resource. */
export type ResourceFreePostPolicy = {
  readonly kind: "resource-free";
  readonly purpose: "append-only-telemetry";
};

/**
 * The erased, registrable form of a route. `execute` parses inputs (throwing
 * `RequestValidationError` → 400), invokes the handler, and parses the result
 * through the response (and meta) schema (throwing `ResponseDriftError` →
 * 500). Schemas stay attached for OpenAPI generation.
 */
export type RouteDefinition = {
  readonly kind: "route";
  readonly descriptor: RouteContract;
  readonly method: HttpMethod;
  readonly path: string;
  /** Stamped by routeGroup — the only way a route becomes registrable. */
  readonly tag: string;
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly access: RouteAccess;
  /** group ∪ route capabilities; the app default merges at registration. */
  readonly capabilities: RouteCapabilities;
  readonly status: 200 | 201 | 202 | 204;
  readonly resourcePolicy?: ResourceFreePostPolicy;
  readonly schemas: {
    readonly params?: z.ZodType;
    readonly query?: z.ZodType;
    readonly body?: z.ZodType;
    /** Absent on no-content (DELETE) routes. */
    readonly response?: z.ZodType;
    readonly meta?: z.ZodType;
  };
  readonly execute: (raw: RawRouteInput) => Promise<RouteResult>;
};

/**
 * What a verb returns: a route WITHOUT a tag. Blueprints are not
 * registrable — `registerRoutes` takes `RouteDefinition[]` only, so a route
 * that never went through `routeGroup` does not compile (the always-a-group
 * rule, mechanically).
 */
export type RouteBlueprint = Omit<RouteDefinition, "tag">;

export {
  buildDefinition,
  buildNoContentDefinition,
  type ErasedNoContentConfig,
  type ErasedRouteConfig,
} from "./route-execution.js";

/**
 * Erased verb input — ErasedRouteConfig minus `method`, hand-written (NOT
 * via Omit: mapped types strip method-syntax bivariance off `handler`,
 * which is load-bearing for the verb call signatures).
 */
export type ErasedVerbConfig = {
  readonly route?: RouteContract;
  readonly path?: string;
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
    ctx: RouteHandlerContext<unknown, unknown, unknown, SubjectRef>,
  ): unknown;
};

/** Erased no-content verb input — same rationale as ErasedVerbConfig. */
export type ErasedNoContentVerbConfig = {
  readonly route?: RouteContract;
  readonly path?: string;
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly capabilities?: RouteCapabilities;
  readonly access: RouteAccess;
  readonly params?: z.ZodType;
  readonly body?: z.ZodType;
  handler(
    ctx: RouteHandlerContext<unknown, undefined, unknown, SubjectRef>,
  ): Promise<void> | void;
};

/** A route card path is literal and mount-relative, never a computed URL string. */
type LiteralMountRelativePath<Path extends string> = string extends Path
  ? never
  : Path extends `/${string}`
    ? Path
    : never;

/** One transient route source: the legacy descriptor or the literal route card path. */
type VerbRouteSource<Method extends HttpMethod, Path extends string> =
  | {
      readonly route: RouteContract<Method, Path>;
      readonly path?: never;
    }
  | {
      readonly route?: never;
      readonly path: LiteralMountRelativePath<Path>;
    };

/** Shared fields every verb declares. */
export type VerbCommon<
  Method extends HttpMethod,
  Path extends string,
  Access extends RouteAccess,
> = VerbRouteSource<Method, Path> & {
  /** OpenAPI operation summary. */
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly access: Access;
  /** Route-rung of the capability ladder (route > group > app). */
  readonly capabilities?: RouteCapabilities;
};

/** Resolve the temporary route source into the descriptor the kit already stores. */
export function resolveVerbRoute(
  config: { readonly route?: RouteContract; readonly path?: string },
  expectedMethod: HttpMethod,
): {
  readonly descriptor: RouteContract;
  readonly method: HttpMethod;
  readonly path: string;
} {
  const hasRoute = config.route !== undefined;
  const hasPath = config.path !== undefined;
  if (hasRoute === hasPath) {
    throw new HttpWiringError(
      `${expectedMethod} helper requires exactly one of route or path`,
    );
  }

  if (config.route !== undefined) {
    if (config.route.method !== expectedMethod) {
      throw new HttpWiringError(
        `${expectedMethod} helper received ${config.route.method} descriptor for ${config.route.template}`,
      );
    }
    return {
      descriptor: config.route,
      method: config.route.method,
      path: config.route.template,
    };
  }

  if (config.path === undefined) {
    throw new HttpWiringError(
      `${expectedMethod} helper requires a literal path when no route is provided`,
    );
  }
  if (!config.path.startsWith("/") || config.path.startsWith("//")) {
    throw new HttpWiringError(
      `${expectedMethod} helper received a path that is not mount-relative`,
    );
  }

  return {
    descriptor: { method: expectedMethod, template: config.path },
    method: expectedMethod,
    path: config.path,
  };
}

/** Path params are required exactly when the path template has `:params`. */
export type VerbParams<
  Path extends string,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
> = [PathParamNames<Path>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: ParamsSchema };
