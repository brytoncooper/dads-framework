import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type { OperationPathParamsShape, PostNoContentOperationContract } from "@dads-framework/core/contract";
import type { PermissionAccess, SessionAccess } from "./access.js";
import {
  resolveNoContentOperationConfig,
  type ErasedOperationNoContentConfig,
  type OperationVerbCommon,
} from "./operation-route.js";
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
  type VerbRouteSource,
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
    ctx: RouteHandlerContext<SchemaOutput<ParamsSchema>, undefined, SchemaOutput<BodySchema>, SubjectRef>,
  ): Promise<void> | void;
} & VerbParams<Path, ParamsSchema>;

type PostNoContentContractSource<
  Path extends string,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined,
> =
  | (VerbRouteSource<"POST", Path> & {
      readonly operation?: never;
      readonly body?: BodySchema;
    } & VerbParams<Path, ParamsSchema>)
  | {
      readonly route?: never;
      readonly path?: never;
      readonly operation: PostNoContentOperationContract<
        Path,
        ParamsSchema & (z.ZodType<OperationPathParamsShape<Path>> | undefined),
        BodySchema
      >;
    };

/** Guarded no-content POST — the handler's subject is non-null by construction. */
export function postNoContentRoute<
  Path extends string,
  Access extends SessionAccess | PermissionAccess,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: PostNoContentContractSource<Path, ParamsSchema, BodySchema> &
    OperationVerbCommon<Access> & {
      handler(
        ctx: RouteHandlerContext<SchemaOutput<ParamsSchema>, undefined, SchemaOutput<BodySchema>, SubjectRef>,
      ): Promise<void> | void;
    },
): RouteBlueprint;
export function postNoContentRoute(config: ErasedNoContentVerbConfig | ErasedOperationNoContentConfig): RouteBlueprint {
  const normalized = resolveNoContentOperationConfig(config, "post-no-content");
  return buildNoContentDefinition({
    ...normalized,
    ...resolveVerbRoute(normalized, "POST"),
  });
}
