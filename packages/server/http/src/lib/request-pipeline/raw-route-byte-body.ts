import type { FastifyRequest } from "fastify";

/**
 * The one media type a byte-body route's request is parsed as, whatever the
 * client sent. The app's byte parser answers it (`byteBodyContentTypes`).
 */
export const BYTE_BODY_PARSE_TYPE = "application/octet-stream";

const sentContentTypes = new WeakMap<FastifyRequest, string | undefined>();

/**
 * Makes Fastify parse this request's body as bytes, whatever it was sent as.
 * Fastify picks the parser from the `content-type` header, and its built-in
 * JSON and text parsers beat a catch-all byte parser, so a `text/plain` or
 * `application/json` body would arrive as a string or an object. Run from the
 * route's own `onRequest`, before the parser is chosen, so it reaches this
 * route alone. The header the client sent stays readable through
 * `contentTypeSentWithBytes`.
 */
export function parseBodyAsBytes(request: FastifyRequest): void {
  sentContentTypes.set(request, request.headers["content-type"]);
  request.headers["content-type"] = BYTE_BODY_PARSE_TYPE;
}

/** The `content-type` the client sent on a byte-body route's request; undefined if it sent none. */
export function contentTypeSentWithBytes(request: FastifyRequest): string | undefined {
  return sentContentTypes.has(request) ? sentContentTypes.get(request) : request.headers["content-type"];
}
