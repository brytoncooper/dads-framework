import { isRecord } from "../parse-guards.js";

/**
 * The JSON layer the importer reads Nx through and writes its outputs with.
 *
 * Nx answers in JSON, so every value that crosses into this package arrives as
 * untyped data. One definition of "a JSON value" and one set of narrowing
 * readers keep that data from being asserted into a shape it does not have.
 * `stableJson` is the other half: the manifest checksum is taken over its
 * bytes, so key order and spacing are part of the contract, not a formatting
 * preference.
 */

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };

/** Parses `value` as JSON data, naming `subject` in every failure. */
export function parseJson(value: string, subject: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonValue(parsed)) throw new Error("value is not valid JSON data");
    return parsed;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "unknown JSON failure";
    throw new Error(`Unable to parse ${subject}: ${message}`, { cause: error });
  }
}

/** True when `value` is data JSON can round-trip without loss. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

/**
 * True when `value` is a JSON array. `Array.isArray` alone answers with
 * `any[]`, which would let untyped elements back into typed code; this states
 * the element type the JSON layer actually guarantees.
 */
export function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** True when `value` is a JSON object rather than an array or a primitive. */
export function isJsonRecord(
  value: JsonValue | undefined,
): value is JsonRecord {
  return isRecord(value);
}

/** `record[property]` when it is an object, and `undefined` otherwise. */
export function readOptionalJsonRecord(
  record: JsonRecord,
  property: string,
): JsonRecord | undefined {
  const value = record[property];
  return isJsonRecord(value) ? value : undefined;
}

/** `record[property]` when it is a string, and `undefined` otherwise. */
export function readOptionalString(
  record: JsonRecord,
  property: string,
): string | undefined {
  const value = record[property];
  return typeof value === "string" ? value : undefined;
}

/** `record[property]` when it is a boolean, and `undefined` otherwise. */
export function readOptionalBoolean(
  record: JsonRecord,
  property: string,
): boolean | undefined {
  const value = record[property];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Serializes `value` with every object key sorted, two-space indentation, and
 * a trailing newline. Two runs over equal data produce equal bytes, which is
 * what makes the manifest checksum meaningful.
 */
export function stableJson(value: unknown): string {
  if (!isJsonValue(value))
    throw new Error("Importer attempted to serialize a non-JSON output value.");
  return `${JSON.stringify(sortJson(value), undefined, 2)}\n`;
}

/** `value` with the keys of every object it contains sorted. */
function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonRecord(value)) return value;
  const sorted: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = sortJson(value[key] ?? null);
  return sorted;
}
