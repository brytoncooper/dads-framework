import type { z } from "zod";
import type { BoundRoute, HttpMethod, RouteContract } from "./api-path.js";
import type { PaginationMeta } from "./pagination.schema.js";

/** `:param` names extracted from a mount-relative route template. */
export type OperationPathParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | OperationPathParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

/** Object output shape a `params` schema must produce for a path template. */
export type OperationPathParamsShape<Path extends string> = Record<
  OperationPathParamNames<Path>,
  string
>;

export type LiteralMountRelativePath<Path extends string> = string extends Path
  ? never
  : Path extends `/${string}`
    ? Path
    : never;

export type OperationQuerySchema = z.ZodType<Record<string, unknown>>;

export type PaginatedOperationQuerySchema = z.ZodType<
  Record<string, unknown> & { page: number; perPage: number }
>;

export type NonArrayOperationResponse<S> =
  S extends z.ZodArray<z.ZodType>
    ? [
        "collections use listOperation — getOperation responses cannot be arrays",
      ]
    : unknown;

export type OperationParamsOption<
  Path extends string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined,
> = [OperationPathParamNames<Path>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: ParamsSchema };

export type OperationBindMethods<
  Method extends HttpMethod,
  Path extends string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined,
> =
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>>
    ? {
        readonly params: ParamsSchema;
        bind(params: z.input<ParamsSchema>): BoundRoute<Method, Path>;
        path(params: z.input<ParamsSchema>): string;
      }
    : {
        readonly params: undefined;
        bind(): BoundRoute<Method, Path>;
        path(): string;
      };

export type GetOperationContract<
  Path extends string = string,
  ResponseSchema extends z.ZodType = z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
  QuerySchema extends OperationQuerySchema | undefined =
    OperationQuerySchema | undefined,
  MetaSchema extends z.ZodType | undefined = z.ZodType | undefined,
> = RouteContract<"GET", Path> & {
  readonly kind: "get";
  readonly params: ParamsSchema;
  readonly query: QuerySchema;
  readonly response: ResponseSchema;
  readonly meta: MetaSchema;
} & OperationBindMethods<"GET", Path, ParamsSchema>;

export type ListOperationContract<
  Path extends string = string,
  ItemSchema extends z.ZodType = z.ZodType,
  QuerySchema extends PaginatedOperationQuerySchema =
    PaginatedOperationQuerySchema,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
  MetaSchema extends z.ZodType<PaginationMeta> | undefined =
    z.ZodType<PaginationMeta> | undefined,
> = RouteContract<"GET", Path> & {
  readonly kind: "list";
  readonly params: ParamsSchema;
  readonly query: QuerySchema;
  readonly item: ItemSchema;
  readonly meta: MetaSchema;
} & OperationBindMethods<"GET", Path, ParamsSchema>;

export type PostOperationContract<
  Path extends string = string,
  ResponseSchema extends z.ZodType = z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
  QuerySchema extends OperationQuerySchema | undefined =
    OperationQuerySchema | undefined,
  BodySchema extends z.ZodType | undefined = z.ZodType | undefined,
  MetaSchema extends z.ZodType | undefined = z.ZodType | undefined,
  Status extends 200 | 201 | 202 = 200 | 201 | 202,
> = RouteContract<"POST", Path> & {
  readonly kind: "post";
  readonly params: ParamsSchema;
  readonly query: QuerySchema;
  readonly body: BodySchema;
  readonly response: ResponseSchema;
  readonly meta: MetaSchema;
  readonly status: Status;
} & OperationBindMethods<"POST", Path, ParamsSchema>;

export type PatchOperationContract<
  Path extends string = string,
  ResponseSchema extends z.ZodType = z.ZodType,
  BodySchema extends z.ZodType = z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
> = RouteContract<"PATCH", Path> & {
  readonly kind: "patch";
  readonly params: ParamsSchema;
  readonly body: BodySchema;
  readonly response: ResponseSchema;
} & OperationBindMethods<"PATCH", Path, ParamsSchema>;

export type PutOperationContract<
  Path extends string = string,
  ResponseSchema extends z.ZodType = z.ZodType,
  BodySchema extends z.ZodType = z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
> = RouteContract<"PUT", Path> & {
  readonly kind: "put";
  readonly params: ParamsSchema;
  readonly body: BodySchema;
  readonly response: ResponseSchema;
} & OperationBindMethods<"PUT", Path, ParamsSchema>;

export type DeleteOperationContract<
  Path extends string = string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined = z.ZodType | undefined,
> = RouteContract<"DELETE", Path> & {
  readonly kind: "delete";
  readonly params: ParamsSchema;
  readonly body: BodySchema;
} & OperationBindMethods<"DELETE", Path, ParamsSchema>;

export type PostNoContentOperationContract<
  Path extends string = string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    z.ZodType<OperationPathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined = z.ZodType | undefined,
> = RouteContract<"POST", Path> & {
  readonly kind: "post-no-content";
  readonly params: ParamsSchema;
  readonly body: BodySchema;
} & OperationBindMethods<"POST", Path, ParamsSchema>;

export type AnyOperationContract =
  | GetOperationContract
  | ListOperationContract
  | PostOperationContract
  | PatchOperationContract
  | PutOperationContract
  | DeleteOperationContract
  | PostNoContentOperationContract;
