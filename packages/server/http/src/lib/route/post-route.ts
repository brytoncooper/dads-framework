import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type {
  OperationPathParamsShape,
  PostOperationContract,
} from "@dads-framework/core/contract";
import { HttpWiringError } from "../http-errors.js";
import type {
  PermissionAccess,
  PublicAccess,
  RouteAccess,
  SessionAccess,
} from "./access.js";
import {
  resolvePostOperationConfig,
  type ErasedOperationPostConfig,
  type ErasedPostVerbConfig,
  type OperationVerbCommon,
} from "./operation-route.js";
import {
  buildDefinition,
  resolveVerbRoute,
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

type PostOperationResourcePolicy<
  Access extends RouteAccess,
  BodySchema extends z.ZodType | undefined,
  Status extends 200 | 201 | 202,
> =
  | { readonly resourcePolicy?: never }
  | (Access extends PublicAccess
      ? Status extends 200
        ? BodySchema extends z.ZodType
          ? { readonly resourcePolicy: ResourceFreePostPolicy }
          : never
        : never
      : never);

/** Operation-backed POST config: path, status, and wire schemas come from `operation`. */
export type PostOperationRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined,
  QuerySchema extends z.ZodType<Record<string, unknown>> | undefined,
  BodySchema extends z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined,
  Status extends 200 | 201 | 202,
> = OperationVerbCommon<Access> & {
  readonly operation: PostOperationContract<
    Path,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    BodySchema,
    MetaSchema,
    Status
  >;
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
} & PostOperationResourcePolicy<Access, BodySchema, Status>;

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
/** Guarded POST declared from a standalone `postOperation` contract. */
export function postRoute<
  Path extends string,
  Access extends SessionAccess | PermissionAccess,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined,
  QuerySchema extends z.ZodType<Record<string, unknown>> | undefined,
  BodySchema extends z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined,
  Status extends 200 | 201 | 202,
>(
  config: PostOperationRouteConfig<
    Path,
    Access,
    SubjectRef,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    BodySchema,
    MetaSchema,
    Status
  >,
): RouteBlueprint;
/** Public POST declared from a standalone `postOperation` contract. */
export function postRoute<
  Path extends string,
  Access extends PublicAccess,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined,
  QuerySchema extends z.ZodType<Record<string, unknown>> | undefined,
  BodySchema extends z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined,
  Status extends 200 | 201 | 202,
>(
  config: PostOperationRouteConfig<
    Path,
    Access,
    SubjectRef | null,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    BodySchema,
    MetaSchema,
    Status
  >,
): RouteBlueprint;
export function postRoute(
  config: ErasedPostVerbConfig | ErasedOperationPostConfig,
): RouteBlueprint {
  const normalized = resolvePostOperationConfig(config);
  const route = buildDefinition({
    ...normalized,
    ...resolveVerbRoute(normalized, "POST"),
  });
  const policy = normalized.resourcePolicy;
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
