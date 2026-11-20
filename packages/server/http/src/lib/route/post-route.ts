import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import { HttpWiringError } from "../http-errors.js";
import type {
  PermissionAccess,
  PublicAccess,
  RouteAccess,
  SessionAccess,
} from "./access.js";
import {
  buildDefinition,
  resolveVerbRoute,
  type ErasedVerbConfig,
  type HandlerResult,
  type PathParamsShape,
  type ResourceFreePostPolicy,
  type RouteBlueprint,
  type RouteHandlerContext,
  type SchemaOutput,
  type VerbCommon,
  type VerbParams,
} from "./route-definition.js";

/**
 * POST — creates and commands. Answers 201 by default; command-style posts
 * whose result is a report (not a created resource) override to 200.
 */
export type PostRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  QuerySchema extends z.ZodType | undefined,
  BodySchema extends z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined,
> = VerbCommon<"POST", Path, Access> & {
  readonly response: ResponseSchema;
  readonly meta?: MetaSchema;
  /** 202 when the POST only accepts work that runs later. */
  readonly status?: 200 | 201 | 202;
  readonly query?: QuerySchema;
  readonly body?: BodySchema;
  handler(
    ctx: RouteHandlerContext<
      SchemaOutput<ParamsSchema>,
      SchemaOutput<QuerySchema>,
      SchemaOutput<BodySchema>,
      Subject
    >,
  ):
    | Promise<HandlerResult<ResponseSchema, MetaSchema>>
    | HandlerResult<ResponseSchema, MetaSchema>;
} & VerbParams<Path, ParamsSchema> &
  PostResourcePolicy<Access, BodySchema>;

type PostResourcePolicy<Access extends RouteAccess, BodySchema> =
  | { readonly resourcePolicy?: never }
  | (Access extends PublicAccess
      ? {
          readonly resourcePolicy: ResourceFreePostPolicy;
          readonly status: 200;
          readonly body: NonNullable<BodySchema>;
        }
      : never);

/** Parsed inputs and subject available to a named POST handler module. */
export type PostRouteHandlerContext<Params, Query, Body, Subject> =
  RouteHandlerContext<Params, Query, Body, Subject>;

/** Data shape a named POST handler returns before the kit envelopes it. */
export type PostRouteHandlerResult<
  ResponseSchema extends z.ZodType,
  MetaSchema extends z.ZodType | undefined = undefined,
> = HandlerResult<ResponseSchema, MetaSchema>;

/** Guarded POST — the handler's subject is non-null by construction. */
export function postRoute<
  Path extends string,
  Access extends SessionAccess | PermissionAccess,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
  MetaSchema extends z.ZodType | undefined = undefined,
>(
  config: PostRouteConfig<
    Path,
    Access,
    SubjectRef,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    BodySchema,
    MetaSchema
  >,
): RouteBlueprint;
/** Public POST — the handler must deal with a null subject. */
export function postRoute<
  Path extends string,
  Access extends PublicAccess,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
  MetaSchema extends z.ZodType | undefined = undefined,
>(
  config: PostRouteConfig<
    Path,
    Access,
    SubjectRef | null,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    BodySchema,
    MetaSchema
  >,
): RouteBlueprint;
export function postRoute(
  config: ErasedVerbConfig & {
    readonly resourcePolicy?: ResourceFreePostPolicy;
  },
): RouteBlueprint {
  const route = buildDefinition({
    ...config,
    ...resolveVerbRoute(config, "POST"),
  });
  const policy = config.resourcePolicy;
  if (policy === undefined) return route;
  assertPublicTelemetry(route, policy);
  return { ...route, resourcePolicy: policy };
}

function assertPublicTelemetry(
  route: RouteBlueprint,
  policy: { readonly kind: unknown; readonly purpose: unknown },
): void {
  if (
    route.access.kind !== "public" ||
    route.status !== 200 ||
    route.schemas.body === undefined ||
    policy.kind !== "resource-free" ||
    policy.purpose !== "append-only-telemetry"
  ) {
    throw new HttpWiringError(
      "A resource-free telemetry POST requires public access, status 200, and a body schema",
    );
  }
}
