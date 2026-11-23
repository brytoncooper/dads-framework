import { componentSchemasOf, isJsonObject, mapRecord, type JsonRecord } from "./document-record.js";

const COMPONENT_REF_PREFIX = "#/components/schemas/";

/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = ["items", "not", "additionalProperties"] as const;

/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS = ["allOf", "oneOf", "anyOf"] as const;

/**
 * Removes `additionalProperties: false` from every schema a response reaches,
 * inline or through a component `$ref`, in an OpenAPI 3.0 document.
 *
 * Adding a response field is not a breaking change, so a client must read a
 * response that has fields it does not know. Generated decoders reject unknown
 * fields when the schema says `additionalProperties: false`. A schema only a
 * request uses keeps it, because the server still rejects fields it does not
 * know. A component a request shares with a response opens: clients never
 * decode a request, and the server validates against its own schemas.
 */
export function openResponseObjects(document: JsonRecord): JsonRecord {
  const components = componentSchemasOf(document);
  const responseSchemas = responseSchemasOf(document["paths"]);
  const reached = componentsReachedFrom(responseSchemas, components);

  const existingComponents = isJsonObject(document["components"]) ? document["components"] : {};
  return {
    ...document,
    paths: mapResponseSchemas(document["paths"], openObjects),
    components: {
      ...existingComponents,
      schemas: Object.fromEntries(
        Object.entries(components).map(([name, schema]) => [name, reached.has(name) ? openObjects(schema) : schema]),
      ),
    },
  };
}

function openObjects(schema: unknown): unknown {
  if (!isJsonObject(schema)) return schema;
  const opened = mapSubschemas(schema, openObjects);
  return Object.fromEntries(
    Object.entries(opened).filter(([key, value]) => !(key === "additionalProperties" && value === false)),
  );
}

function componentsReachedFrom(schemas: readonly unknown[], components: JsonRecord): Set<string> {
  const reached = new Set<string>();
  const pending = schemas.flatMap(componentRefsIn);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...componentRefsIn(components[name]));
  }
  return reached;
}

function componentRefsIn(schema: unknown): string[] {
  if (!isJsonObject(schema)) return [];
  const ref = schema["$ref"];
  const own =
    typeof ref === "string" && ref.startsWith(COMPONENT_REF_PREFIX) ? [ref.slice(COMPONENT_REF_PREFIX.length)] : [];
  return [...own, ...subschemasOf(schema).flatMap(componentRefsIn)];
}

/**
 * The schemas nested in a schema, found by keyword. A property name is never
 * a keyword, so a property named `default` or `required` is walked too.
 */
function subschemasOf(schema: JsonRecord): unknown[] {
  const properties = schema["properties"];
  return [
    ...(isJsonObject(properties) ? Object.values(properties) : []),
    ...SCHEMA_KEYWORDS.map((keyword) => schema[keyword]).filter(isJsonObject),
    ...SCHEMA_LIST_KEYWORDS.flatMap((keyword) => listOf(schema[keyword])),
  ];
}

function mapSubschemas(schema: JsonRecord, map: (schema: unknown) => unknown): JsonRecord {
  const mapped: JsonRecord = { ...schema };
  const properties = schema["properties"];
  if (isJsonObject(properties)) mapped["properties"] = mapRecord(properties, map);
  for (const keyword of SCHEMA_KEYWORDS) {
    const subschema = schema[keyword];
    if (isJsonObject(subschema)) mapped[keyword] = map(subschema);
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const subschemas = schema[keyword];
    if (Array.isArray(subschemas)) mapped[keyword] = subschemas.map(map);
  }
  return mapped;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function responseSchemasOf(paths: unknown): unknown[] {
  return valuesOf(paths)
    .flatMap(valuesOf)
    .flatMap((operation) => (isJsonObject(operation) ? valuesOf(operation["responses"]) : []))
    .flatMap((response) => (isJsonObject(response) ? valuesOf(response["content"]) : []))
    .flatMap((media) => (isJsonObject(media) ? [media["schema"]] : []));
}

function valuesOf(value: unknown): unknown[] {
  return isJsonObject(value) ? Object.values(value) : [];
}

/** Maps the schema of every response body of every operation. */
function mapResponseSchemas(paths: unknown, map: (schema: unknown) => unknown): unknown {
  if (!isJsonObject(paths)) return paths;
  return mapRecord(paths, (pathItem) =>
    isJsonObject(pathItem) ? mapRecord(pathItem, (operation) => mapResponses(operation, map)) : pathItem,
  );
}

function mapResponses(operation: unknown, map: (schema: unknown) => unknown): unknown {
  if (!isJsonObject(operation) || !isJsonObject(operation["responses"])) {
    return operation;
  }
  return {
    ...operation,
    responses: mapRecord(operation["responses"], (response) => mapContentSchemas(response, map)),
  };
}

function mapContentSchemas(holder: unknown, map: (schema: unknown) => unknown): unknown {
  if (!isJsonObject(holder) || !isJsonObject(holder["content"])) return holder;
  return {
    ...holder,
    content: mapRecord(holder["content"], (media) =>
      isJsonObject(media) ? { ...media, schema: map(media["schema"]) } : media,
    ),
  };
}
