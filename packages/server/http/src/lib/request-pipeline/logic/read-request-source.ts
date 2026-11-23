import { isObjectValue } from "../../object-value.js";
import type { ResourceIdSource } from "../../route/access.js";
import { singleRequestHeader } from "./single-request-header.js";

/** The parts of a request that a route's declared id or context source can name. */
export type SourceReadableRequest = {
  readonly headers: Record<string, string | string[] | undefined>;
  /** Original occurrences let enforcement detect duplicate headers even after joining. */
  readonly raw?: { readonly rawHeaders: readonly string[] };
  readonly params: unknown;
  /** Fastify's parsed body — read RAW here (enforcement precedes Zod). */
  readonly body?: unknown;
  /** Fastify's parsed query — read RAW here (enforcement precedes Zod). */
  readonly query?: unknown;
};

function paramOf(params: unknown, name: string): string | undefined {
  if (!isObjectValue(params)) return undefined;
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

/** Resolve only the explicitly declared request source for a permission check. */
export function resolveResourceId(source: ResourceIdSource, request: SourceReadableRequest): string | undefined {
  switch (source.kind) {
    case "fixed":
      return source.id;
    case "param":
      return paramOf(request.params, source.name);
    case "body":
      return paramOf(request.body, source.name);
    case "query":
      return paramOf(request.query, source.name);
    case "header":
      return singleRequestHeader(source.name, request.headers, request.raw?.rawHeaders);
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/** Only omission selects technical identity; present malformed inputs still fail resolution. */
export function isTechnicalContextAbsent(source: ResourceIdSource, request: SourceReadableRequest): boolean {
  if (source.kind === "header") return request.headers[source.name.toLowerCase()] === undefined;
  if (source.kind !== "query") return false;
  if (request.query === undefined) return true;
  return (
    typeof request.query === "object" &&
    request.query !== null &&
    !Object.prototype.hasOwnProperty.call(request.query, source.name)
  );
}
