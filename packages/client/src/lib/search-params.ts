/**
 * Turn a contract-validated query object into a query string.
 *
 * Runs on the OUTPUT of the endpoint's query schema, so the shapes it has to
 * handle are exactly the shapes a contract can describe: primitives, arrays of
 * primitives, dates, and absent values. Anything else is a contract this
 * serializer has never been taught, and it says so rather than sending
 * `[object Object]` to the API.
 */
export function toSearchParams(
  query: Record<string, unknown>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    appendValue(params, key, value);
  }
  return params;
}

function appendValue(
  params: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      params.append(key, serializeScalar(key, item));
    }
    return;
  }
  params.append(key, serializeScalar(key, value));
}

function serializeScalar(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new Error(
    `Query parameter "${key}" is not serializable as a query string value`,
  );
}
