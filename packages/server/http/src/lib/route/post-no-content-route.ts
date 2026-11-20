import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type { PermissionAccess, SessionAccess } from "./access.js";
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
 * A guarded POST that accepts a report and answers 204 with no body: no
 * response schema exists on this config, and the handler returns nothing.
 * For a caller that only tells the server something (a device's periodic
 * check-in) and must learn nothing back. A POST that creates a resource or
 * returns a result is `postRoute`.
 */
export type PostNoContentRouteConfig<
  Path extends string,
  Access extends SessionAccess | PermissionAccess,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined,
> = VerbCommon<"POST", Path, Access> & {
  readonly body?: BodySchema;
  handler(
    ctx: RouteHandlerContext<
      SchemaOutput<ParamsSchema>,
      undefined,
      SchemaOutput<BodySchema>,
      SubjectRef
    >,
  ): Promise<void> | void;
} & VerbParams<Path, ParamsSchema>;

/** Guarded no-content POST — the handler's subject is non-null by construction. */
export function postNoContentRoute<
  Path extends string,
  Access extends SessionAccess | PermissionAccess,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: PostNoContentRouteConfig<Path, Access, ParamsSchema, BodySchema>,
): RouteBlueprint;
export function postNoContentRoute(
  config: ErasedNoContentVerbConfig,
): RouteBlueprint {
  return buildNoContentDefinition({
    ...config,
    ...resolveVerbRoute(config, "POST"),
  });
}
