import { z } from "zod";

import {
  apiPath,
  type AnyOperationContract,
  type BoundRoute,
  type DeleteOperationContract,
  type GetOperationContract,
  type ListOperationContract,
  type PaginationMeta,
  type PatchOperationContract,
  type PostNoContentOperationContract,
  type PostOperationContract,
  type PutOperationContract,
} from "@dads-framework/core/contract";

import {
  getFromApi,
  getPageFromApi,
  getPageWithMetaFromApi,
  sendToApi,
  sendToApiWithoutResponse,
  type ApiArgument,
  type ApiPage,
  type ApiPageWithMeta,
  type ApiQueryArgument,
} from "./api-verbs.js";
import { toSearchParams } from "./search-params.js";
import { type ApiRequestHeaders, sendApiRequest } from "./send-api-request.js";

/** Transport-level per-call options accepted by every operation call. */
export type CallApiOptions = {
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
};

/** Parsed `{ data, meta }` reply for GET/POST operations that declare `meta`. */
export type ApiDataWithMeta<TData, TMeta> = {
  readonly data: TData;
  readonly meta: TMeta;
};

type ParamsOf<Op> = Op extends { readonly params: infer P } ? P : undefined;
type QueryOf<Op> = Op extends { readonly query: infer Q } ? Q : undefined;
type BodyOf<Op> = Op extends { readonly body: infer B } ? B : undefined;

type ParamsField<ParamsSchema> = [ParamsSchema] extends [z.ZodType]
  ? { readonly params: z.input<ParamsSchema> }
  : Record<never, never>;

type QueryField<QuerySchema> = [QuerySchema] extends [z.ZodType]
  ? Record<never, never> extends z.input<QuerySchema>
    ? { readonly query?: z.input<QuerySchema> }
    : { readonly query: z.input<QuerySchema> }
  : Record<never, never>;

type BodyField<BodySchema> = [BodySchema] extends [z.ZodType]
  ? undefined extends z.input<BodySchema>
    ? { readonly body?: z.input<BodySchema> }
    : { readonly body: z.input<BodySchema> }
  : Record<never, never>;

/** Strictly inferred input object for calling an operation contract. */
export type OperationCallInput<Op extends AnyOperationContract> = ParamsField<
  ParamsOf<Op>
> &
  QueryField<QueryOf<Op>> &
  BodyField<BodyOf<Op>> &
  CallApiOptions;

/** Optional input tuple when all fields are optional; required otherwise. */
export type OperationCallArgs<Op extends AnyOperationContract> =
  Record<never, never> extends OperationCallInput<Op>
    ? [input?: OperationCallInput<Op>]
    : [input: OperationCallInput<Op>];

/** Strictly inferred value produced by `callApi(operation, ...)`. */
export type OperationCallResult<Op extends AnyOperationContract> = Op extends {
  readonly kind: "delete" | "post-no-content";
}
  ? undefined
  : Op extends {
        readonly kind: "list";
        readonly item: infer Item extends z.ZodType;
        readonly meta: infer Meta;
      }
    ? [Meta] extends [z.ZodType<PaginationMeta>]
      ? ApiPageWithMeta<z.output<Item>, z.output<Meta>>
      : ApiPage<z.output<Item>>
    : Op extends {
          readonly response: infer Response extends z.ZodType;
          readonly meta: infer Meta;
        }
      ? [Meta] extends [z.ZodType]
        ? ApiDataWithMeta<z.output<Response>, z.output<Meta>>
        : z.output<Response>
      : Op extends { readonly response: infer Response extends z.ZodType }
        ? z.output<Response>
        : never;

/** Promise returned by `callApi` and `createApiClient` methods. */
export type OperationCallPromise<Op extends AnyOperationContract> = Op extends {
  readonly kind: "delete" | "post-no-content";
}
  ? Promise<void>
  : Promise<OperationCallResult<Op>>;

/** Named map of standalone operations passed to `createApiClient`. */
export type OperationRecord = Readonly<Record<string, AnyOperationContract>>;

/** One typed client method synthesized from an operation contract. */
export type OperationClientMethod<Op extends AnyOperationContract> = (
  ...args: OperationCallArgs<Op>
) => OperationCallPromise<Op>;

/** Frozen, per-operation client returned by `createApiClient`. */
export type ApiClient<Ops extends OperationRecord> = Readonly<{
  [K in keyof Ops]: OperationClientMethod<Ops[K]>;
}>;

type RawCallInput = {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
};

const dataWithMetaEnvelopeSchema = z.object({
  data: z.unknown(),
  meta: z.unknown(),
});

function requestOptionsOf(input: RawCallInput | undefined): CallApiOptions {
  return {
    ...(input?.signal === undefined ? {} : { signal: input.signal }),
    ...(input?.headers === undefined ? {} : { headers: input.headers }),
  };
}

function queryArgOf(
  schema: z.ZodType<Record<string, unknown>> | undefined,
  value: unknown,
): { readonly query?: ApiQueryArgument<z.ZodType<Record<string, unknown>>> } {
  if (schema === undefined) return {};
  return { query: { schema, value: value ?? {} } };
}

function bodyArgOf(
  schema: z.ZodType | undefined,
  value: unknown,
): { readonly body?: ApiArgument<z.ZodType> } {
  if (schema === undefined) return {};
  return { body: { schema, value } };
}

async function sendWithMeta(request: {
  readonly route: BoundRoute;
  readonly returns: z.ZodType;
  readonly meta: z.ZodType;
  readonly query?: ApiQueryArgument<z.ZodType<Record<string, unknown>>>;
  readonly body?: ApiArgument<z.ZodType>;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
}): Promise<ApiDataWithMeta<unknown, unknown>> {
  const search =
    request.query === undefined
      ? undefined
      : toSearchParams(request.query.schema.parse(request.query.value));
  const response = await sendApiRequest({
    path: apiPath(request.route.path),
    method: request.route.method,
    body: request.body?.schema.parse(request.body.value),
    search,
    signal: request.signal,
    headers: request.headers,
  });
  const envelope = dataWithMetaEnvelopeSchema.parse(await response.json());
  return {
    data: request.returns.parse(envelope.data),
    meta: request.meta.parse(envelope.meta),
  };
}

function callGet(
  op: GetOperationContract,
  input: RawCallInput | undefined,
): Promise<unknown> {
  const route = op.params === undefined ? op.bind() : op.bind(input?.params);
  const query = queryArgOf(op.query, input?.query);
  const options = requestOptionsOf(input);
  if (op.meta !== undefined) {
    return sendWithMeta({
      route,
      returns: op.response,
      meta: op.meta,
      ...query,
      ...options,
    });
  }
  return getFromApi({
    route,
    returns: op.response,
    ...query,
    ...options,
  });
}

function callList(
  op: ListOperationContract,
  input: RawCallInput | undefined,
): Promise<unknown> {
  const route = op.params === undefined ? op.bind() : op.bind(input?.params);
  const query = queryArgOf(op.query, input?.query);
  const options = requestOptionsOf(input);
  if (op.meta !== undefined) {
    return getPageWithMetaFromApi({
      route,
      returns: op.item,
      meta: op.meta,
      ...query,
      ...options,
    });
  }
  return getPageFromApi({
    route,
    returns: op.item,
    ...query,
    ...options,
  });
}

function callPost(
  op: PostOperationContract,
  input: RawCallInput | undefined,
): Promise<unknown> {
  const route = op.params === undefined ? op.bind() : op.bind(input?.params);
  const query = queryArgOf(op.query, input?.query);
  const body = bodyArgOf(op.body, input?.body);
  const options = requestOptionsOf(input);
  if (op.meta !== undefined) {
    return sendWithMeta({
      route,
      returns: op.response,
      meta: op.meta,
      ...query,
      ...body,
      ...options,
    });
  }
  return sendToApi({
    route,
    returns: op.response,
    ...query,
    ...body,
    ...options,
  });
}

function callMutate(
  op: PatchOperationContract | PutOperationContract,
  input: RawCallInput | undefined,
): Promise<unknown> {
  const route = op.params === undefined ? op.bind() : op.bind(input?.params);
  return sendToApi({
    route,
    returns: op.response,
    ...bodyArgOf(op.body, input?.body),
    ...requestOptionsOf(input),
  });
}

function callNoContent(
  op: DeleteOperationContract | PostNoContentOperationContract,
  input: RawCallInput | undefined,
): Promise<void> {
  const route = op.params === undefined ? op.bind() : op.bind(input?.params);
  return sendToApiWithoutResponse({
    route,
    ...bodyArgOf(op.body, input?.body),
    ...requestOptionsOf(input),
  });
}

async function executeOperation(
  operation: AnyOperationContract,
  input: RawCallInput | undefined,
): Promise<unknown> {
  switch (operation.kind) {
    case "get":
      return await callGet(operation, input);
    case "list":
      return await callList(operation, input);
    case "post":
      return await callPost(operation, input);
    case "patch":
    case "put":
      return await callMutate(operation, input);
    case "delete":
    case "post-no-content":
      await callNoContent(operation, input);
      return undefined;
  }
}

/**
 * Call one standalone operation contract with full input validation and
 * envelope parsing.
 */
export function callApi<Op extends AnyOperationContract>(
  operation: Op,
  ...args: OperationCallArgs<Op>
): OperationCallPromise<Op>;
export function callApi(
  operation: AnyOperationContract,
  input?: RawCallInput,
): Promise<unknown> {
  return executeOperation(operation, input);
}

/**
 * Compose a frozen, strictly typed API client from any subset of standalone
 * operation contracts.
 */
export function createApiClient<const Ops extends OperationRecord>(
  operations: Ops,
): ApiClient<Ops>;
export function createApiClient(
  operations: OperationRecord,
): Readonly<Record<string, (input?: RawCallInput) => Promise<unknown>>> {
  const client: Record<string, (input?: RawCallInput) => Promise<unknown>> = {};
  for (const [name, operation] of Object.entries(operations)) {
    client[name] = (input?: RawCallInput) => executeOperation(operation, input);
  }
  return Object.freeze(client);
}
