import type {
  ApiRequestHeaders,
  ApiRequestDispatch,
} from "./send-api-request.js";

/**
 * A composition seam for metadata which belongs to a particular request context.
 *
 * The transport deliberately knows neither feature flags nor business contexts.
 * It only gives an application runtime the exact headers that the caller already
 * captured for this request, so overlapping requests cannot read ambient state.
 */
export type RequestMetadataProvider = (
  request: Pick<ApiRequestDispatch, "path" | "method" | "headers">,
) => ApiRequestHeaders | undefined;

/** Observes an HTTP response before success/error conversion consumes it. */
export type ApiResponseObserver = (
  response: Response,
  request: Pick<ApiRequestDispatch, "path" | "method" | "headers">,
) => void;

let metadataProvider: RequestMetadataProvider | undefined;
let responseObserver: ApiResponseObserver | undefined;

/**
 * Install application-owned metadata behavior for every request.
 *
 * Registration is intentionally singular: browser composition has one feature
 * state runtime. Returning a cleanup function keeps isolated tests and browser
 * teardown from leaking a prior runtime into the next application instance.
 */
export function registerRequestMetadata(
  provider: RequestMetadataProvider | undefined,
  observer: ApiResponseObserver | undefined,
): () => void {
  metadataProvider = provider;
  responseObserver = observer;
  return () => {
    if (metadataProvider === provider) metadataProvider = undefined;
    if (responseObserver === observer) responseObserver = undefined;
  };
}

export function requestMetadataFor(
  request: Pick<ApiRequestDispatch, "path" | "method" | "headers">,
): ApiRequestHeaders | undefined {
  return metadataProvider?.(request);
}

export function observeApiResponse(
  response: Response,
  request: Pick<ApiRequestDispatch, "path" | "method" | "headers">,
): void {
  responseObserver?.(response, request);
}
