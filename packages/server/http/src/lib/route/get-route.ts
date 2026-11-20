import type { z } from "zod";
import type { ScopeAnswer, SubjectRef } from "@dads-framework/access/runtime";
import { HttpWiringError } from "../http-errors.js";
import type {
  PermissionAccess,
  PublicAccess,
  RouteAccess,
  ScopedAccess,
  SessionAccess,
} from "./access.js";
import {
  buildDefinition,
  resolveVerbRoute,
  type ErasedVerbConfig,
  type HandlerResult,
  type PathParamsShape,
  type RouteBlueprint,
  type RouteHandlerContext,
  type SchemaOutput,
  type VerbCommon,
  type VerbParams,
} from "./route-definition.js";

/**
 * A getRoute response cannot be an array — collections are `listRoute`
 * (paginated by construction). The tuple brand surfaces in the compile
 * error as the explanation.
 */
type NonArrayResponse<S> =
  S extends z.ZodArray<z.ZodType>
    ? ["collections use listRoute — getRoute responses cannot be arrays"]
    : unknown;

/**
 * GET — a single read. The config has NO `body` key (excess-property
 * compile error) and the response cannot be an array (that is a
 * collection — use `listRoute`). Status is always 200.
 */
export type GetRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  QuerySchema extends z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined,
  BodySchema extends z.ZodType | undefined,
  Context extends object = Record<never, never>,
> = VerbCommon<"GET", Path, Access> & {
  readonly response: ResponseSchema & NonArrayResponse<ResponseSchema>;
  /** Declares `{ data, meta }` responses; shapes the handler's return. */
  readonly meta?: MetaSchema;
  readonly query?: QuerySchema;
  handler(
    ctx: RouteHandlerContext<
      SchemaOutput<ParamsSchema>,
      SchemaOutput<QuerySchema>,
      SchemaOutput<BodySchema>,
      Subject
    > &
      Context,
  ):
    | Promise<HandlerResult<ResponseSchema, MetaSchema>>
    | HandlerResult<ResponseSchema, MetaSchema>;
} & VerbParams<Path, ParamsSchema>;

/** Parsed inputs and subject available to a named GET handler module. */
export type GetRouteHandlerContext<Params, Query, Subject> =
  RouteHandlerContext<Params, Query, undefined, Subject>;

/** Data shape a named GET handler returns before the kit envelopes it. */
export type GetRouteHandlerResult<
  ResponseSchema extends z.ZodType,
  MetaSchema extends z.ZodType | undefined = undefined,
> = HandlerResult<ResponseSchema, MetaSchema>;

/**
 * A GET with no path parameters answers a question about a set (desk counts,
 * a summary), so it may be scoped like a list. A GET-one (`/things/:id`)
 * never is: one record is a `requires` check.
 */
type GetRouteAccess<Path extends string> =
  | SessionAccess
  | PermissionAccess
  | PublicAccess
  | (Path extends `${string}:${string}` ? never : ScopedAccess);

type GetRouteSubject<Access extends GetRouteAccess<string>> =
  Access extends PublicAccess ? SubjectRef | null : SubjectRef;

type GetRouteContext<Access extends GetRouteAccess<string>> =
  Access extends ScopedAccess
    ? { readonly scope: ScopeAnswer }
    : Record<never, never>;

/**
 * GET subject nullability follows the declared access: guarded handlers get a
 * subject, while public handlers must account for an anonymous request.
 */
export function getRoute<
  Path extends string,
  Access extends GetRouteAccess<Path>,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
  MetaSchema extends z.ZodType | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: GetRouteConfig<
    Path,
    Access,
    GetRouteSubject<Access>,
    ResponseSchema,
    ParamsSchema,
    QuerySchema,
    MetaSchema,
    BodySchema,
    GetRouteContext<Access>
  >,
): RouteBlueprint;
export function getRoute(config: ErasedVerbConfig): RouteBlueprint {
  const resolved = resolveVerbRoute(config, "GET");
  return buildDefinition({
    ...config,
    ...resolved,
    handler: (ctx) => {
      if (config.access.kind === "scoped" && ctx.scope === undefined) {
        // No answers means no scope to render: refuse rather than answer
        // unscoped. An empty answer is still an answer and reaches the SQL.
        throw new HttpWiringError(
          `scoped route ${resolved.path} ran without a scope answer`,
        );
      }
      return config.handler(ctx);
    },
  });
}
