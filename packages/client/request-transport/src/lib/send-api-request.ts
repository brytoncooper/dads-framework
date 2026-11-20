import {
  ACCESS_REFUSAL_HEADER,
  CLIENT_CONTEXT_HEADER,
  LOCALE_HEADER,
  REQUEST_ID_HEADER,
  type HttpMethod,
} from "@dads-framework/contract";

import { isAccessRefusal } from "./access-refusal.js";
import { NetworkError, toApiError } from "./api-error.js";
import { announceApiExchange } from "./api-exchange-channel.js";
import { currentClientContextHeader } from "./client-context.js";
import { createRequestId } from "./create-request-id.js";
import { currentRequestLocale } from "./request-locale.js";
import { observeApiResponse, requestMetadataFor } from "./request-metadata.js";
import { announceUnauthorizedResponse } from "./unauthorized-response-channel.js";

export type { HttpMethod } from "@dads-framework/contract";

/** Explicit request-local metadata; the transport never selects an authorization context. */
export type ApiRequestHeaders = Readonly<Record<string, string>>;

/** One wire call, with every value already validated by its contract schema. */
export type ApiRequestDispatch = {
  readonly path: string;
  readonly method: HttpMethod;
  readonly body: unknown;
  readonly search: URLSearchParams | undefined;
  readonly signal: AbortSignal | undefined;
  readonly headers?: ApiRequestHeaders | undefined;
  readonly accept?: string;
};

/**
 * Perform one request and return the response only when the API accepted it.
 *
 * Everything that must be true of every call lives here: the session cookie
 * rides along, a fresh correlation id is minted for the logs, a failure
 * becomes a typed `ApiError` instead of a raw `Response`, and a 401 announces
 * itself on the unauthorized-response channel on its way out.
 */
export async function sendApiRequest(
  dispatch: ApiRequestDispatch,
): Promise<Response> {
  const requestId = createRequestId();
  const response = await requestApi(dispatch, requestId);

  if (response.ok) {
    return response;
  }
  throw await toRejection(response, requestId);
}

async function requestApi(
  dispatch: ApiRequestDispatch,
  requestId: string,
): Promise<Response> {
  const startedAt = performance.now();
  try {
    const response = await fetch(buildRequestUrl(dispatch), {
      method: dispatch.method,
      credentials: "include",
      headers: buildHeaders(dispatch, requestId),
      ...(dispatch.body === undefined
        ? {}
        : { body: JSON.stringify(dispatch.body) }),
      ...(dispatch.signal === undefined ? {} : { signal: dispatch.signal }),
    });
    // Observers see both accepted and rejected HTTP responses. Feature state
    // hashes on a 409 are just as meaningful as hashes on a 200.
    observeApiResponse(response, dispatch);
    announce(dispatch, requestId, startedAt, {
      status: response.status,
      refusedForAccess: isAccessRefusal(
        response.status,
        response.headers.get(ACCESS_REFUSAL_HEADER),
      ),
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // A call that never reached the API is still an exchange worth reporting:
    // it is what a telemetry breadcrumb needs to explain what came next.
    announce(dispatch, requestId, startedAt, {
      status: null,
      refusedForAccess: false,
    });
    throw new NetworkError(error);
  }
}

/** The path, never the query string — a query can carry whatever a caller put there. */
function announce(
  dispatch: ApiRequestDispatch,
  requestId: string,
  startedAt: number,
  answer: {
    readonly status: number | null;
    readonly refusedForAccess: boolean;
  },
): void {
  announceApiExchange({
    method: dispatch.method,
    path: dispatch.path,
    status: answer.status,
    requestId,
    durationMs: Math.round(performance.now() - startedAt),
    refusedForAccess: answer.refusedForAccess,
  });
}

function buildRequestUrl(dispatch: ApiRequestDispatch): string {
  const query = dispatch.search?.toString() ?? "";
  return query.length > 0 ? `${dispatch.path}?${query}` : dispatch.path;
}

function buildHeaders(
  dispatch: ApiRequestDispatch,
  requestId: string,
): Record<string, string> {
  const headers = new Headers(dispatch.headers);
  const metadata = requestMetadataFor(dispatch);
  if (metadata !== undefined) {
    for (const [name, value] of Object.entries(metadata))
      headers.set(name, value);
  }
  headers.set("Accept", dispatch.accept ?? "application/json");
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set(LOCALE_HEADER, currentRequestLocale());
  const clientContext = currentClientContextHeader();
  if (clientContext !== undefined)
    headers.set(CLIENT_CONTEXT_HEADER, clientContext);
  if (dispatch.body !== undefined)
    headers.set("Content-Type", "application/json");
  return Object.fromEntries(headers.entries());
}

async function toRejection(
  response: Response,
  requestId: string,
): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = toApiError(response.status, body, requestId);
  if (response.status === 401) {
    announceUnauthorizedResponse();
  }
  return error;
}
