import type { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type {
  OperationPathParamsShape,
  PatchOperationContract,
  PutOperationContract,
} from "@dads-framework/core/contract";
import type { PermissionAccess, PublicAccess, RouteAccess, SessionAccess } from "./access.js";
import {
  resolveMutateOperationConfig,
  type ErasedOperationVerbConfig,
  type OperationVerbCommon,
} from "./operation-route.js";
import {
  buildDefinition,
  resolveVerbRoute,
  type ErasedVerbConfig,
  type PathParamsShape,
  type RouteBlueprint,
  type RouteHandlerContext,
  type SchemaOutput,
  type VerbCommon,
  type VerbParams,
  type VerbRouteSource,
} from "./route-definition.js";

/**
 * PATCH (partial update) and PUT (replacement) — `body` is REQUIRED (a
 * body-less mutation is a compile error) and the config has NO `query`,
 * `meta`, or `status` keys: declaring them is an excess-property error.
 * Always 200.
 */
export type MutateRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType,
  QuerySchema extends z.ZodType | undefined,
  Method extends "PATCH" | "PUT" = "PATCH" | "PUT",
> = VerbCommon<Method, Path, Access> & {
  readonly response: ResponseSchema;
  readonly body: BodySchema;
  readonly handler: (
    ctx: RouteHandlerContext<SchemaOutput<ParamsSchema>, SchemaOutput<QuerySchema>, SchemaOutput<BodySchema>, Subject>,
  ) => Promise<z.input<ResponseSchema>> | z.input<ResponseSchema>;
} & VerbParams<Path, ParamsSchema>;

type MutateRouteContractSource<
  Path extends string,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType,
  Method extends "PATCH" | "PUT",
> =
  | (VerbRouteSource<Method, Path> & {
      readonly operation?: never;
      readonly response: ResponseSchema;
      readonly body: BodySchema;
    } & VerbParams<Path, ParamsSchema>)
  | {
      readonly route?: never;
      readonly path?: never;
      readonly operation: Method extends "PATCH"
        ? PatchOperationContract<
            Path,
            ResponseSchema,
            BodySchema,
            ParamsSchema & (z.ZodType<OperationPathParamsShape<Path>> | undefined)
          >
        : PutOperationContract<
            Path,
            ResponseSchema,
            BodySchema,
            ParamsSchema & (z.ZodType<OperationPathParamsShape<Path>> | undefined)
          >;
    };

/** Parsed inputs and subject available to a named PATCH or PUT handler. */
export type MutateRouteHandlerContext<Params, Body, Subject> = RouteHandlerContext<Params, undefined, Body, Subject>;

/** Data shape a named PATCH or PUT handler returns before enveloping. */
export type MutateRouteHandlerResult<ResponseSchema extends z.ZodType> = z.input<ResponseSchema>;

type MutateRouteAccess = SessionAccess | PermissionAccess | PublicAccess;

type MutateRouteSubject<Access extends MutateRouteAccess> = Access extends PublicAccess
  ? SubjectRef | null
  : SubjectRef;

/** PATCH handler subject nullability follows the declared access. */
export function patchRoute<
  Path extends string,
  Access extends MutateRouteAccess,
  ResponseSchema extends z.ZodType,
  BodySchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
>(
  config: MutateRouteContractSource<Path, ResponseSchema, ParamsSchema, BodySchema, "PATCH"> &
    OperationVerbCommon<Access> & {
      readonly handler: (
        ctx: RouteHandlerContext<
          SchemaOutput<ParamsSchema>,
          SchemaOutput<QuerySchema>,
          SchemaOutput<BodySchema>,
          MutateRouteSubject<Access>
        >,
      ) => Promise<z.input<ResponseSchema>> | z.input<ResponseSchema>;
    },
): RouteBlueprint;
export function patchRoute(config: ErasedVerbConfig | ErasedOperationVerbConfig): RouteBlueprint {
  const normalized = resolveMutateOperationConfig(config, "patch");
  return buildDefinition({
    ...normalized,
    ...resolveVerbRoute(normalized, "PATCH"),
  });
}

/** PUT handler subject nullability follows the declared access. */
export function putRoute<
  Path extends string,
  Access extends MutateRouteAccess,
  ResponseSchema extends z.ZodType,
  BodySchema extends z.ZodType,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
>(
  config: MutateRouteContractSource<Path, ResponseSchema, ParamsSchema, BodySchema, "PUT"> &
    OperationVerbCommon<Access> & {
      readonly handler: (
        ctx: RouteHandlerContext<
          SchemaOutput<ParamsSchema>,
          SchemaOutput<QuerySchema>,
          SchemaOutput<BodySchema>,
          MutateRouteSubject<Access>
        >,
      ) => Promise<z.input<ResponseSchema>> | z.input<ResponseSchema>;
    },
): RouteBlueprint;
export function putRoute(config: ErasedVerbConfig | ErasedOperationVerbConfig): RouteBlueprint {
  const normalized = resolveMutateOperationConfig(config, "put");
  return buildDefinition({
    ...normalized,
    ...resolveVerbRoute(normalized, "PUT"),
  });
}
