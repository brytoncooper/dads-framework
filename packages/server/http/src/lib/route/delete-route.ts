import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type { DeleteOperationContract, OperationPathParamsShape } from "@dads-framework/core/contract";
import type { PermissionAccess, PublicAccess, RouteAccess, SessionAccess } from "./access.js";
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
    ctx: RouteHandlerContext<SchemaOutput<ParamsSchema>, undefined, SchemaOutput<BodySchema>, Subject>,
  ): Promise<void> | void;
} & VerbParams<Path, ParamsSchema>;

type DeleteRouteContractSource<
  Path extends string,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined,
> =
  | (VerbRouteSource<"DELETE", Path> & {
      readonly operation?: never;
      readonly body?: BodySchema;
    } & VerbParams<Path, ParamsSchema>)
  | {
      readonly route?: never;
      readonly path?: never;
      readonly operation: DeleteOperationContract<
        Path,
        ParamsSchema & (z.ZodType<OperationPathParamsShape<Path>> | undefined),
        BodySchema
      >;
    };

/** Parsed inputs and subject available to a named DELETE handler module. */
export type DeleteRouteHandlerContext<Params, Body, Subject> = RouteHandlerContext<Params, undefined, Body, Subject>;

type DeleteRouteAccess = SessionAccess | PermissionAccess | PublicAccess;

type DeleteRouteSubject<Access extends DeleteRouteAccess> = Access extends PublicAccess
  ? SubjectRef | null
  : SubjectRef;

/** DELETE handler subject nullability follows the declared access. */
export function deleteRoute<
  Path extends string,
  Access extends DeleteRouteAccess,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: DeleteRouteContractSource<Path, ParamsSchema, BodySchema> &
    OperationVerbCommon<Access> & {
      handler(
        ctx: RouteHandlerContext<
          SchemaOutput<ParamsSchema>,
          undefined,
          SchemaOutput<BodySchema>,
          DeleteRouteSubject<Access>
        >,
      ): Promise<void> | void;
    },
): RouteBlueprint;
export function deleteRoute(config: ErasedNoContentVerbConfig | ErasedOperationNoContentConfig): RouteBlueprint {
  const normalized = resolveNoContentOperationConfig(config, "delete");
  return buildNoContentDefinition({
    ...normalized,
    ...resolveVerbRoute(normalized, "DELETE"),
  });
}
