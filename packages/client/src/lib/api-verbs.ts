import { z } from "zod";

import {
  apiPath,
  type BoundRoute,
  type HttpMethod,
  type PaginationMeta,
  paginationMetaSchema,
} from "@dads-framework/core/contract";

import { toSearchParams } from "./search-params.js";
import { type ApiRequestHeaders, sendApiRequest } from "./send-api-request.js";

/**
 * The three verbs every `web` API client calls.
 *
 * Each one takes the contract schema for what it sends and the contract schema
 * for what it expects back, so both sides of a call are validated at the same
 * seam and a caller never names a type by hand. That is the whole reason the
 * schemas sit in the signature: a generic parameter the caller supplies (or an
 * `as` on the result) would let the client's idea of a payload drift from the
 * server's silently, which is the failure mode this lib exists to prevent.
 */

/** A value paired with the contract schema that proves it is well formed. */
export type ApiArgument<TSchema extends z.ZodType> = {
  readonly schema: TSchema;
  readonly value: z.input<TSchema>;
};

/**
 * A query object paired with its schema.
 *
 * Narrower than {@link ApiArgument} because a query string can only be built
 * from a record of named values.
 */
export type ApiQueryArgument<TQuery extends z.ZodType<Record<string, unknown>>> = {
  readonly schema: TQuery;
  readonly value: z.input<TQuery>;
};

/** One page of a collection endpoint, already unwrapped from its envelope. */
export type ApiPage<TItem> = {
  readonly items: readonly TItem[];
  readonly meta: PaginationMeta;
};

/** A page whose endpoint declares its own meta, extending the pagination meta. */
export type ApiPageWithMeta<TItem, TMeta extends PaginationMeta> = {
  readonly items: readonly TItem[];
  readonly meta: TMeta;
};

export type BinaryRequest<TBody extends z.ZodType, TQuery extends z.ZodType<Record<string, unknown>>> = {
  readonly route: BoundRoute;
  readonly body?: ApiArgument<TBody>;
  readonly query?: ApiQueryArgument<TQuery>;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
  readonly accept?: string;
};

type GetRequest<TQuery extends z.ZodType<Record<string, unknown>>, TData extends z.ZodType> = {
  readonly route: BoundRoute<"GET">;
  readonly returns: TData;
  readonly query?: ApiQueryArgument<TQuery>;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
};

type SendRequest<
  TBody extends z.ZodType,
  TData extends z.ZodType,
  TQuery extends z.ZodType<Record<string, unknown>>,
> = {
  readonly query?: ApiQueryArgument<TQuery>;
  readonly returns: TData;
  readonly body?: ApiArgument<TBody>;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
} & MutationRequestLocation;

type NoContentRequest<TBody extends z.ZodType> = {
  readonly body?: ApiArgument<TBody>;
  readonly signal?: AbortSignal;
  readonly headers?: ApiRequestHeaders;
} & MutationRequestLocation;

type MutationMethod = Exclude<HttpMethod, "GET">;

type MutationRequestLocation = {
  readonly route: BoundRoute<MutationMethod>;
};

type ResolvedRequestLocation = {
  readonly path: string;
  readonly method: HttpMethod;
};

/**
 * Read one resource: `GET path` unwrapped from its `{ data }` envelope.
 */
export async function getFromApi<TQuery extends z.ZodType<Record<string, unknown>>, TData extends z.ZodType>(
  request: GetRequest<TQuery, TData>,
): Promise<z.output<TData>> {
  const location = getRequestLocation(request);
  const response = await sendApiRequest({
    path: location.path,
    method: location.method,
    body: undefined,
    search: toValidatedSearch(request.query),
    signal: request.signal,
    headers: request.headers,
  });
  return unwrapData(await response.json(), request.returns);
}

/**
 * Read one page of a collection: `GET path` unwrapped to `{ items, meta }`.
 *
 * Separate from {@link getFromApi} because a paginated endpoint's `meta` is
 * part of the answer, not decoration — a caller that dropped it could not
 * render the next page.
 */
export async function getPageFromApi<TQuery extends z.ZodType<Record<string, unknown>>, TItem extends z.ZodType>(
  request: GetRequest<TQuery, TItem>,
): Promise<ApiPage<z.output<TItem>>> {
  const location = getRequestLocation(request);
  const response = await sendApiRequest({
    path: location.path,
    method: location.method,
    body: undefined,
    search: toValidatedSearch(request.query),
    signal: request.signal,
    headers: request.headers,
  });
  const envelope = paginatedEnvelopeSchema.parse(await response.json());
  return {
    items: envelope.data.map((item) => request.returns.parse(item)),
    meta: envelope.meta,
  };
}

/**
 * Read one page of a collection whose endpoint declares its own meta (a
 * schema extending `paginationMetaSchema`), such as counts the page shows
 * beside the rows: `GET path` unwrapped to `{ items, meta }`, the meta
 * parsed by the endpoint's own meta schema.
 */
export async function getPageWithMetaFromApi<
  TQuery extends z.ZodType<Record<string, unknown>>,
  TItem extends z.ZodType,
  TMeta extends z.ZodType<PaginationMeta>,
>(
  request: GetRequest<TQuery, TItem> & { readonly meta: TMeta },
): Promise<ApiPageWithMeta<z.output<TItem>, z.output<TMeta>>> {
  const location = getRequestLocation(request);
  const response = await sendApiRequest({
    path: location.path,
    method: location.method,
    body: undefined,
    search: toValidatedSearch(request.query),
    signal: request.signal,
    headers: request.headers,
  });
  const envelope = z.object({ data: z.array(z.unknown()), meta: z.unknown() }).parse(await response.json());
  return {
    items: envelope.data.map((item) => request.returns.parse(item)),
    meta: request.meta.parse(envelope.meta),
  };
}

/**
 * Change something: any non-GET verb, with the body validated before it is
 * sent and the response unwrapped from its `{ data }` envelope.
 *
 * Validating the request body here rather than at the call site means a
 * malformed payload fails in the caller's own stack trace, against the
 * server's own contract, instead of coming back as a 400 the UI has to
 * interpret.
 */
export async function sendToApi<
  TBody extends z.ZodType,
  TData extends z.ZodType,
  TQuery extends z.ZodType<Record<string, unknown>> = z.ZodType<Record<string, unknown>>,
>(request: SendRequest<TBody, TData, TQuery>): Promise<z.output<TData>> {
  const location = mutationRequestLocation(request);
  const response = await sendApiRequest({
    path: location.path,
    method: location.method,
    body: request.body?.schema.parse(request.body.value),
    search: toValidatedSearch(request.query),
    signal: request.signal,
    headers: request.headers,
  });
  return unwrapData(await response.json(), request.returns);
}

/**
 * Change something whose answer is "done": a verb the API replies to with
 * `204 No Content`.
 *
 * Separate from {@link sendToApi} because a 204 has no body at all, and
 * reading one is not a degenerate case of reading a `{ data }` envelope — it
 * throws. Every `deleteRoute` in this repo answers this way, and each still
 * declares a request body (an audit reason), which is why the body argument
 * survives while the response schema does not.
 */
export async function sendToApiWithoutResponse<TBody extends z.ZodType>(
  request: NoContentRequest<TBody>,
): Promise<void> {
  const location = mutationRequestLocation(request);
  await sendApiRequest({
    path: location.path,
    method: location.method,
    body: request.body?.schema.parse(request.body.value),
    search: undefined,
    signal: request.signal,
    headers: request.headers,
  });
}

/** Binary endpoints keep the transport's credentials, metadata, and error mapping. */
export async function requestBinary<TBody extends z.ZodType, TQuery extends z.ZodType<Record<string, unknown>>>(
  request: BinaryRequest<TBody, TQuery>,
): Promise<Uint8Array> {
  const response = await sendApiRequest({
    path: apiPath(request.route.path),
    method: request.route.method,
    body: request.body?.schema.parse(request.body.value),
    search: toValidatedSearch(request.query),
    signal: request.signal,
    headers: request.headers,
    accept: request.accept ?? "application/octet-stream",
  });
  return new Uint8Array(await response.arrayBuffer());
}

function getRequestLocation(request: { readonly route: BoundRoute<"GET"> }): ResolvedRequestLocation {
  return { path: apiPath(request.route.path), method: request.route.method };
}

function mutationRequestLocation(request: { readonly route: BoundRoute<MutationMethod> }): ResolvedRequestLocation {
  return { path: apiPath(request.route.path), method: request.route.method };
}

/**
 * The envelope shape, checked before the payload it carries.
 *
 * `data` is left `unknown` here on purpose: the endpoint's own contract parses
 * it in a second step, which keeps the envelope check independent of the
 * caller's schema and gives a schema mismatch an error message that names the
 * resource rather than the envelope.
 */
const successEnvelopeSchema = z.object({ data: z.unknown() });

const paginatedEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  meta: paginationMetaSchema,
});

function unwrapData<TData extends z.ZodType>(payload: unknown, returns: TData): z.output<TData> {
  return returns.parse(successEnvelopeSchema.parse(payload).data);
}

function toValidatedSearch<TQuery extends z.ZodType<Record<string, unknown>>>(
  query: ApiQueryArgument<TQuery> | undefined,
): URLSearchParams | undefined {
  if (query === undefined) {
    return undefined;
  }
  return toSearchParams(query.schema.parse(query.value));
}
