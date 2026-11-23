import { isObjectValue } from "../../object-value.js";

export type JsonRecord = Record<string, unknown>;

export function componentSchemasOf(document: JsonRecord): JsonRecord {
  const components = document["components"];
  if (!isJsonObject(components) || !isJsonObject(components["schemas"])) return {};
  return components["schemas"];
}

export function mapRecord(record: JsonRecord, map: (value: unknown) => unknown): JsonRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

export function isJsonObject(value: unknown): value is JsonRecord {
  return isObjectValue(value) && !Array.isArray(value);
}
