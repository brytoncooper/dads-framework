import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type {
  PermissionAccess,
  PublicAccess,
  RouteAccess,
  SessionAccess,
} from "./access.js";
import {
  buildNoContentDefinition,
  resolveVerbRoute,
  type ErasedNoContentVerbConfig,
  type PathParamsShape,
  type RouteBlueprint,
  type RouteHandlerContext,
  type SchemaOutput,
  type VerbCommon,
  type VerbParams,
} from "./route-definition.js";

/**
 * DELETE — THE no-content shape: no response schema exists on this config,
 * the handler returns nothing, the kit answers 204 with no body. A DELETE
 * that needs to return data is a kit-growth conversation, not a variant.
 * An optional request `body` is allowed when the resource identity alone is
 * not enough (e.g. revoke a named relation for a subject).
 */
export type DeleteRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined = undefined,
> = VerbCommon<"DELETE", Path, Access> & {
  readonly body?: BodySchema;
  handler(
    ctx: RouteHandlerContext<
      SchemaOutput<ParamsSchema>,
      undefined,
      SchemaOutput<BodySchema>,
      Subject
    >,
  ): Promise<void> | void;
} & VerbParams<Path, ParamsSchema>;

/** Parsed inputs and subject available to a named DELETE handler module. */
export type DeleteRouteHandlerContext<Params, Body, Subject> =
  RouteHandlerContext<Params, undefined, Body, Subject>;

type DeleteRouteFn = {
  /** Guarded DELETE — the handler's subject is non-null by construction. */
  <
    Path extends string,
    Access extends SessionAccess | PermissionAccess,
    ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined =
      undefined,
    BodySchema extends z.ZodType | undefined = undefined,
  >(
    config: DeleteRouteConfig<
      Path,
      Access,
      SubjectRef,
      ParamsSchema,
      BodySchema
    >,
  ): RouteBlueprint;
  /** Public DELETE — the handler must deal with a null subject. */
  <
    Path extends string,
    Access extends PublicAccess,
    ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined =
      undefined,
    BodySchema extends z.ZodType | undefined = undefined,
  >(
    config: DeleteRouteConfig<
      Path,
      Access,
      SubjectRef | null,
      ParamsSchema,
      BodySchema
    >,
  ): RouteBlueprint;
};

export const deleteRoute: DeleteRouteFn = (
  config: ErasedNoContentVerbConfig,
): RouteBlueprint =>
  buildNoContentDefinition({
    ...config,
    ...resolveVerbRoute(config, "DELETE"),
  });
