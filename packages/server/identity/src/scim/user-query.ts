import type { ScimUserFilter, ScimUserQuery } from "./directory.js";
import { ScimError, userAttributePath } from "./protocol.js";

export const maxPageSize = 100;

function filterError(): ScimError {
  return new ScimError(400, "Expected a supported equality filter.", "invalidFilter");
}

function parseFilter(filter: string): ScimUserFilter {
  const match = /^([^\s]+)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)$/i.exec(filter.trim());
  const rawAttribute = match?.[1];
  const literal = match?.[2];
  if (!rawAttribute || !literal) throw filterError();
  return equalityFilter(userAttributePath(rawAttribute), parseFilterLiteral(literal));
}

export function parseFilterLiteral(literal: string): unknown {
  try {
    const value: unknown = JSON.parse(literal);
    return value;
  } catch {
    throw filterError();
  }
}

function equalityFilter(attribute: string, value: unknown): ScimUserFilter {
  if (attribute === "active" && typeof value === "boolean") return { attribute, value };
  const fields: readonly Exclude<ScimUserFilter["attribute"], "active">[] = [
    "id",
    "userName",
    "externalId",
    "displayName",
    "emails.value",
  ];
  const canonical = fields.find((key) => key.toLowerCase() === attribute);
  if (!canonical || typeof value !== "string") throw filterError();
  return { attribute: canonical, value };
}

function integerParameter(params: URLSearchParams, name: string, fallback: number): number {
  const value = params.get(name);
  if (value === null) return fallback;
  if (/^-?\d+$/.test(value)) {
    const integer = Number(value);
    if (Number.isSafeInteger(integer)) return integer;
  }
  throw new ScimError(400, `Invalid ${name}.`, "invalidValue");
}

export function scimUserQuery(params: URLSearchParams): ScimUserQuery {
  const filter = params.get("filter");
  const page = scimPage(params);
  return filter === null ? page : { ...page, filter: parseFilter(filter) };
}

export function scimPage(params: URLSearchParams): Pick<ScimUserQuery, "startIndex" | "count"> {
  const startIndex = Math.max(1, integerParameter(params, "startIndex", 1));
  const count = Math.min(maxPageSize, Math.max(0, integerParameter(params, "count", maxPageSize)));
  return { startIndex, count };
}
