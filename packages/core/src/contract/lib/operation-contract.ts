import type { z } from "zod";
import type { BoundRoute, HttpMethod } from "./api-path.js";
import type {
  DeleteOperationContract,
  GetOperationContract,
  ListOperationContract,
  LiteralMountRelativePath,
  NonArrayOperationResponse,
  OperationParamsOption,
  OperationPathParamsShape,
  OperationQuerySchema,
  PaginatedOperationQuerySchema,
  PatchOperationContract,
  PostNoContentOperationContract,
  PostOperationContract,
  PutOperationContract,
} from "./operation-contract-types.js";
import type { PaginationMeta } from "./pagination.schema.js";

const PARAM_SEGMENT = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
const HAS_PARAM_SEGMENT = /:([a-zA-Z_][a-zA-Z0-9_]*)/;

/** Interpolate `:param` placeholders in a mount-relative template with URL encoding. */
export function bindOperationPath(
  template: string,
  params?: Readonly<Record<string, string>>,
): string {
  validateTemplatePath(template);
  return template.replace(PARAM_SEGMENT, (_match, name: string) => {
    const value = params?.[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Missing required path parameter "${name}" for operation template "${template}".`,
      );
    }
    return encodeURIComponent(value);
  });
}

function validateTemplatePath(template: string): void {
  if (!template.startsWith("/") || template.startsWith("//")) {
    throw new Error(
      `Operation path "${template}" must be mount-relative and start with a single "/".`,
    );
  }
}

function parseParamRecord(
  template: string,
  paramsSchema: z.ZodType,
  params: unknown,
): Record<string, string> {
  const parsed = paramsSchema.parse(params);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Operation params schema for "${template}" must parse to a record of strings.`,
    );
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(
        `Operation path parameter "${key}" for "${template}" must parse to a string.`,
      );
    }
    record[key] = value;
  }
  return record;
}

function createBinder(
  method: HttpMethod,
  template: string,
  paramsSchema: z.ZodType | undefined,
): {
  bind(params?: unknown): BoundRoute;
  path(params?: unknown): string;
} {
  validateTemplatePath(template);
  if (paramsSchema === undefined && HAS_PARAM_SEGMENT.test(template)) {
    throw new Error(
      `Operation path "${template}" declares path parameters and requires a params schema.`,
    );
  }
  const path = (params?: unknown): string => {
    if (paramsSchema === undefined) return template;
    return bindOperationPath(
      template,
      parseParamRecord(template, paramsSchema, params),
    );
  };
  return {
    bind: (params?: unknown) => ({ method, template, path: path(params) }),
    path,
  };
}

function buildOperation(
  method: HttpMethod,
  template: string,
  paramsSchema: z.ZodType | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const binder = createBinder(method, template, paramsSchema);
  return Object.freeze({
    method,
    template,
    params: paramsSchema,
    ...fields,
    ...binder,
  });
}

/** Define a standalone GET operation contract (single resource; arrays refused). */
export function getOperation<
  const Path extends string,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
  QuerySchema extends OperationQuerySchema | undefined = undefined,
  MetaSchema extends z.ZodType | undefined = undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly response: ResponseSchema &
      NonArrayOperationResponse<ResponseSchema>;
    readonly query?: QuerySchema;
    readonly meta?: MetaSchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): GetOperationContract<
  Path,
  ResponseSchema,
  ParamsSchema,
  QuerySchema,
  MetaSchema
>;
export function getOperation(config: {
  readonly path: string;
  readonly response: z.ZodType;
  readonly params?: z.ZodType;
  readonly query?: OperationQuerySchema;
  readonly meta?: z.ZodType;
}): Record<string, unknown> {
  return buildOperation("GET", config.path, config.params, {
    kind: "get",
    query: config.query,
    response: config.response,
    meta: config.meta,
  });
}

/** Define a standalone paginated LIST operation contract. */
export function listOperation<
  const Path extends string,
  ItemSchema extends z.ZodType,
  QuerySchema extends PaginatedOperationQuerySchema,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
  MetaSchema extends z.ZodType<PaginationMeta> | undefined = undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly item: ItemSchema;
    readonly query: QuerySchema;
    readonly meta?: MetaSchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): ListOperationContract<
  Path,
  ItemSchema,
  QuerySchema,
  ParamsSchema,
  MetaSchema
>;
export function listOperation(config: {
  readonly path: string;
  readonly item: z.ZodType;
  readonly query: PaginatedOperationQuerySchema;
  readonly params?: z.ZodType;
  readonly meta?: z.ZodType<PaginationMeta>;
}): Record<string, unknown> {
  return buildOperation("GET", config.path, config.params, {
    kind: "list",
    query: config.query,
    item: config.item,
    meta: config.meta,
  });
}

/** Define a standalone POST operation contract (creates or commands returning data). */
export function postOperation<
  const Path extends string,
  ResponseSchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
  QuerySchema extends OperationQuerySchema | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
  MetaSchema extends z.ZodType | undefined = undefined,
  const Status extends 200 | 201 | 202 = 201,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly response: ResponseSchema;
    readonly body?: BodySchema;
    readonly query?: QuerySchema;
    readonly meta?: MetaSchema;
    readonly status?: Status;
  } & OperationParamsOption<Path, ParamsSchema>,
): PostOperationContract<
  Path,
  ResponseSchema,
  ParamsSchema,
  QuerySchema,
  BodySchema,
  MetaSchema,
  Status
>;
export function postOperation(config: {
  readonly path: string;
  readonly response: z.ZodType;
  readonly params?: z.ZodType;
  readonly query?: OperationQuerySchema;
  readonly body?: z.ZodType;
  readonly meta?: z.ZodType;
  readonly status?: 200 | 201 | 202;
}): Record<string, unknown> {
  return buildOperation("POST", config.path, config.params, {
    kind: "post",
    query: config.query,
    body: config.body,
    response: config.response,
    meta: config.meta,
    status: config.status ?? 201,
  });
}

/** Define a standalone PATCH operation contract (`body` required). */
export function patchOperation<
  const Path extends string,
  ResponseSchema extends z.ZodType,
  BodySchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly body: BodySchema;
    readonly response: ResponseSchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): PatchOperationContract<Path, ResponseSchema, BodySchema, ParamsSchema>;
export function patchOperation(config: {
  readonly path: string;
  readonly body: z.ZodType;
  readonly response: z.ZodType;
  readonly params?: z.ZodType;
}): Record<string, unknown> {
  return buildOperation("PATCH", config.path, config.params, {
    kind: "patch",
    body: config.body,
    response: config.response,
  });
}

/** Define a standalone PUT operation contract (`body` required). */
export function putOperation<
  const Path extends string,
  ResponseSchema extends z.ZodType,
  BodySchema extends z.ZodType,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly body: BodySchema;
    readonly response: ResponseSchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): PutOperationContract<Path, ResponseSchema, BodySchema, ParamsSchema>;
export function putOperation(config: {
  readonly path: string;
  readonly body: z.ZodType;
  readonly response: z.ZodType;
  readonly params?: z.ZodType;
}): Record<string, unknown> {
  return buildOperation("PUT", config.path, config.params, {
    kind: "put",
    body: config.body,
    response: config.response,
  });
}

/** Define a standalone DELETE operation contract (`204 No Content`). */
export function deleteOperation<
  const Path extends string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly body?: BodySchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): DeleteOperationContract<Path, ParamsSchema, BodySchema>;
export function deleteOperation(config: {
  readonly path: string;
  readonly params?: z.ZodType;
  readonly body?: z.ZodType;
}): Record<string, unknown> {
  return buildOperation("DELETE", config.path, config.params, {
    kind: "delete",
    body: config.body,
  });
}

/** Define a standalone no-content POST operation contract (`204 No Content`). */
export function postNoContentOperation<
  const Path extends string,
  ParamsSchema extends z.ZodType<OperationPathParamsShape<Path>> | undefined =
    undefined,
  BodySchema extends z.ZodType | undefined = undefined,
>(
  config: {
    readonly path: LiteralMountRelativePath<Path>;
    readonly body?: BodySchema;
  } & OperationParamsOption<Path, ParamsSchema>,
): PostNoContentOperationContract<Path, ParamsSchema, BodySchema>;
export function postNoContentOperation(config: {
  readonly path: string;
  readonly params?: z.ZodType;
  readonly body?: z.ZodType;
}): Record<string, unknown> {
  return buildOperation("POST", config.path, config.params, {
    kind: "post-no-content",
    body: config.body,
  });
}
