import { capitalizeInitial } from "./capitalize-initial.js";
import {
  componentSchemasOf,
  isJsonObject,
  mapRecord,
  type JsonRecord,
} from "./document-record.js";

type Discriminator = {
  readonly propertyName: string;
  readonly values: readonly string[];
};

const COMPONENT_REF_PREFIX = "#/components/schemas/";

/** Keywords whose values are data, never nested schemas. */
const DATA_KEYWORDS = new Set([
  "enum",
  "const",
  "default",
  "example",
  "examples",
  "required",
  "discriminator",
]);

/**
 * Gives every choose-one type in an OpenAPI 3.0 document a discriminator, so
 * code generators emit one tagged enum instead of a bag of optional fields.
 *
 * A `oneOf` or `anyOf` qualifies when every branch is an object with the same
 * required property holding one distinct literal value per branch. Each inline
 * branch moves into its own component, named after where it sits plus its tag
 * value, because generators only honor a discriminator over `$ref` branches.
 * A qualifying `anyOf` becomes a `oneOf`: the distinct tags already make the
 * branches exclusive.
 *
 * Throws when a `oneOf` has no such property, naming every one.
 */
export function addDiscriminators(document: JsonRecord): JsonRecord {
  const originalComponents = componentSchemasOf(document);
  const components = new Map<string, unknown>(
    Object.entries(originalComponents),
  );
  const untagged: string[] = [];

  const resolve = (schema: unknown): unknown => {
    if (!isJsonObject(schema) || typeof schema["$ref"] !== "string")
      return schema;
    const ref = schema["$ref"];
    if (!ref.startsWith(COMPONENT_REF_PREFIX)) return schema;
    return originalComponents[ref.slice(COMPONENT_REF_PREFIX.length)];
  };

  const addComponent = (name: string, schema: unknown): string => {
    const existing = components.get(name);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(schema)
    ) {
      throw new Error(
        `addDiscriminators: component "${name}" already exists with a different shape`,
      );
    }
    components.set(name, schema);
    return `${COMPONENT_REF_PREFIX}${name}`;
  };

  const walk = (schema: unknown, stem: string): unknown => {
    if (Array.isArray(schema)) {
      return schema.map((item: unknown) => walk(item, stem));
    }
    if (!isJsonObject(schema)) return schema;

    const union = unionOf(schema);
    if (union === null) return walkKeywords(schema, stem);
    const discriminator = discriminatorOf(union.branches.map(resolve));
    if (discriminator === null) {
      if (union.key === "oneOf") untagged.push(stem);
      return walkKeywords(schema, stem);
    }

    return {
      ...walkKeywords(withoutKey(schema, union.key), stem),
      ...taggedUnion(union.branches, discriminator, stem),
    };
  };

  const taggedUnion = (
    branches: readonly unknown[],
    discriminator: Discriminator,
    stem: string,
  ): JsonRecord => {
    const mapping: Record<string, string> = {};
    const refs = discriminator.values.map((value, index) => {
      const branch = branches[index];
      const name = `${stem}${discriminatorNameStem(value)}`;
      const ref =
        isJsonObject(branch) && typeof branch["$ref"] === "string"
          ? branch["$ref"]
          : addComponent(name, walk(branch, name));
      mapping[value] = ref;
      return { $ref: ref };
    });
    return {
      oneOf: refs,
      discriminator: { propertyName: discriminator.propertyName, mapping },
    };
  };

  const walkKeywords = (schema: JsonRecord, stem: string): JsonRecord =>
    mapRecordWithKeys(schema, (key, value) => walkKeyword(key, value, stem));

  const walkKeyword = (key: string, value: unknown, stem: string): unknown => {
    if (DATA_KEYWORDS.has(key)) return value;
    if (key === "properties" && isJsonObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([property, schema]) => [
          property,
          walk(schema, `${stem}${discriminatorNameStem(property)}`),
        ]),
      );
    }
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      return value.map((branch: unknown, index) =>
        walk(branch, `${stem}Option${index + 1}`),
      );
    }
    if (key === "items") return walk(value, `${stem}Item`);
    if (key === "additionalProperties") return walk(value, `${stem}Value`);
    return walk(value, stem);
  };

  for (const [name, schema] of Object.entries(originalComponents)) {
    components.set(name, walk(schema, name));
  }
  const paths = walkPaths(document["paths"], walk);

  if (untagged.length > 0) {
    throw new Error(
      `addDiscriminators: these oneOf types have no type tag: ${untagged.join(", ")}. Give every branch one shared required literal property (z.discriminatedUnion).`,
    );
  }

  const existingComponents = isJsonObject(document["components"])
    ? document["components"]
    : {};
  return {
    ...document,
    paths,
    components: {
      ...existingComponents,
      schemas: Object.fromEntries(components),
    },
  };
}

/** The schema's `oneOf`, else its `anyOf`, when it has one. */
function unionOf(
  schema: JsonRecord,
): { readonly key: "oneOf" | "anyOf"; readonly branches: unknown[] } | null {
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) return { key, branches };
  }
  return null;
}

/**
 * The property every branch requires with a single literal value, distinct per
 * branch, in branch order. The first such property of the first branch wins.
 */
function discriminatorOf(branches: readonly unknown[]): Discriminator | null {
  if (branches.length < 2) return null;
  const [first] = branches;
  if (!isJsonObject(first) || !isJsonObject(first["properties"])) return null;

  for (const propertyName of Object.keys(first["properties"])) {
    const values = branches.map((branch) =>
      requiredLiteral(branch, propertyName),
    );
    const literals = values.filter((value): value is string => value !== null);
    if (
      literals.length === branches.length &&
      new Set(literals).size === literals.length
    ) {
      return { propertyName, values: literals };
    }
  }
  return null;
}

function requiredLiteral(branch: unknown, propertyName: string): string | null {
  if (!isJsonObject(branch) || !isJsonObject(branch["properties"])) return null;
  const required = branch["required"];
  if (!Array.isArray(required) || !required.includes(propertyName)) return null;

  const property = branch["properties"][propertyName];
  if (!isJsonObject(property)) return null;
  if (typeof property["const"] === "string") return property["const"];
  const literals = property["enum"];
  return Array.isArray(literals) &&
    literals.length === 1 &&
    typeof literals[0] === "string"
    ? literals[0]
    : null;
}

/** Inline schemas in operations: parameters, request bodies and responses. */
function walkPaths(
  paths: unknown,
  walk: (schema: unknown, stem: string) => unknown,
): unknown {
  if (!isJsonObject(paths)) return paths;
  return mapRecord(paths, (pathItem) =>
    isJsonObject(pathItem)
      ? mapRecord(pathItem, (operation) => walkOperation(operation, walk))
      : pathItem,
  );
}

function walkOperation(
  operation: unknown,
  walk: (schema: unknown, stem: string) => unknown,
): unknown {
  if (!isJsonObject(operation)) return operation;
  const stem = discriminatorNameStem(
    typeof operation["operationId"] === "string"
      ? operation["operationId"]
      : "",
  );
  const parameters = Array.isArray(operation["parameters"])
    ? operation["parameters"].map((parameter: unknown) =>
        isJsonObject(parameter) && typeof parameter["name"] === "string"
          ? {
              ...parameter,
              schema: walk(
                parameter["schema"],
                `${stem}${discriminatorNameStem(parameter["name"])}Parameter`,
              ),
            }
          : parameter,
      )
    : operation["parameters"];
  return {
    ...operation,
    ...(parameters === undefined ? {} : { parameters }),
    ...(isJsonObject(operation["requestBody"])
      ? {
          requestBody: walkContent(
            operation["requestBody"],
            `${stem}Body`,
            walk,
          ),
        }
      : {}),
    ...(isJsonObject(operation["responses"])
      ? {
          responses: Object.fromEntries(
            Object.entries(operation["responses"]).map(([status, response]) => [
              status,
              walkContent(response, `${stem}Response${status}`, walk),
            ]),
          ),
        }
      : {}),
  };
}

function walkContent(
  holder: unknown,
  stem: string,
  walk: (schema: unknown, stem: string) => unknown,
): unknown {
  if (!isJsonObject(holder) || !isJsonObject(holder["content"])) return holder;
  return {
    ...holder,
    content: mapRecord(holder["content"], (media) =>
      isJsonObject(media)
        ? { ...media, schema: walk(media["schema"], stem) }
        : media,
    ),
  };
}

function mapRecordWithKeys(
  record: JsonRecord,
  map: (key: string, value: unknown) => unknown,
): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, map(key, value)]),
  );
}

function withoutKey(record: JsonRecord, omitted: string): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== omitted),
  );
}

function discriminatorNameStem(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => {
      const lower = word === word.toUpperCase() ? word.toLowerCase() : word;
      return capitalizeInitial(lower);
    })
    .join("");
}
