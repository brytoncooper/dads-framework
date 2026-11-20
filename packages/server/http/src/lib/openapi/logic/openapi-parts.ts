import { z } from "zod";

import { byCodePoint } from "./by-code-point.js";

/**
 * An OpenAPI document as parts, for committing it: one file per route tag,
 * plus `_shared.json` for the document's header and any schema no single tag
 * owns. Two pull requests that add routes under different tags then change
 * different files instead of both rewriting one large document.
 *
 * A route's tag is the name its `routeGroup(...)` declares, so a tag's part
 * belongs to the routes file that declares it. Every component schema is
 * placed by the operations that reach it (directly or through another
 * schema): reached from one tag, it lives in that tag's part; from two or
 * more, or from none, in `_shared.json`.
 *
 * `bundleOpenApiParts` puts the parts back together. The result is the same
 * document (deep-equal); its keys are sorted rather than in route order,
 * which no reader depends on (Spectral and oasdiff ignore key order).
 * Shared by the writer and every reader of committed parts, so "what a part
 * is" has one definition.
 */

/** The file holding the header and the schemas no single tag owns. */
export const SHARED_OPENAPI_PART = "_shared.json";

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

type Operations = Record<string, unknown>;
type Paths = Record<string, Operations>;
type Schemas = Record<string, unknown>;

// foreign-spec: an OpenAPI 3.0 document; every key the spec allows is kept.
const openApiDocumentSchema = z.looseObject({
  openapi: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.looseObject({
    schemas: z.record(z.string(), z.unknown()),
  }),
});

// foreign-spec: an OpenAPI operation object, read only for its tags.
const operationTagsSchema = z.looseObject({
  tags: z.array(z.string()).min(1),
});

// foreign-spec: the document header (openapi, info, tags) travels as is.
const sharedPartSchema = z.looseObject({
  openapi: z.string(),
  components: z.strictObject({
    schemas: z.record(z.string(), z.unknown()),
  }),
});

const tagPartSchema = z.strictObject({
  tag: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.strictObject({
    schemas: z.record(z.string(), z.unknown()),
  }),
});

type TagPart = z.infer<typeof tagPartSchema>;

/** `"Products recipes"` → `products-recipes.json`. */
export function openApiPartFileName(tag: string): string {
  const slug = tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length === 0) {
    throw new Error(
      `OpenAPI tag "${tag}" has no letters or digits to name its file`,
    );
  }
  return `${slug}.json`;
}

/**
 * Splits a whole document into its parts, keyed by file name. Throws on
 * anything the parts could not carry back: an operation with no tag, a
 * path-level field beside the operations, a component kind other than
 * schemas, two tags naming one file.
 */
export function splitOpenApiDocument(
  document: unknown,
): ReadonlyMap<string, Record<string, unknown>> {
  const { paths, components, ...header } =
    openApiDocumentSchema.parse(document);
  const { schemas, ...otherComponents } = components;
  refuseOtherComponents(Object.keys(otherComponents));

  const tagParts = partsByTag(paths);
  const sharedSchemas = placeSchemas(schemas, tagParts);

  const parts = new Map<string, Record<string, unknown>>();
  parts.set(SHARED_OPENAPI_PART, {
    ...header,
    components: { schemas: sortedByKey(sharedSchemas) },
  });
  for (const part of [...tagParts.values()].sort((first, second) =>
    byCodePoint(first.tag, second.tag),
  )) {
    parts.set(openApiPartFileName(part.tag), {
      tag: part.tag,
      paths: sortedByKey(part.paths),
      components: { schemas: sortedByKey(part.components.schemas) },
    });
  }
  return parts;
}

/**
 * Puts the parts back into one document: `_shared.json`'s header, every
 * part's operations and every schema. Throws when two parts define the same
 * operation or schema, which a split never produces.
 */
export function bundleOpenApiParts(
  parts: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const { components, ...header } = sharedPartSchema.parse(
    parts.get(SHARED_OPENAPI_PART),
  );
  const paths: Paths = {};
  const schemas: Schemas = { ...components.schemas };

  for (const [fileName, value] of parts) {
    if (fileName === SHARED_OPENAPI_PART) continue;
    const part = tagPartSchema.parse(value);
    assertArtifactTagFile(fileName, part.tag);
    addOperations(paths, part.paths);
    addSchemas(schemas, part.components.schemas);
  }

  return {
    ...header,
    paths: sortedByKey(paths),
    components: { schemas: sortedByKey(schemas) },
  };
}

function refuseOtherComponents(kinds: readonly string[]): void {
  if (kinds.length > 0) {
    throw new Error(
      `OpenAPI parts carry components.schemas only; found ${kinds.join(", ")}`,
    );
  }
}

/** Each operation into the part of its first tag. */
function partsByTag(paths: Paths): Map<string, TagPart> {
  const tagParts = new Map<string, TagPart>();
  const fileOwners = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      refusePathLevelField(path, method);
      const tag = operationTagsSchema.parse(operation).tags[0] ?? "";
      const part = tagPartFor(tag, tagParts, fileOwners);
      part.paths[path] = { ...part.paths[path], [method]: operation };
    }
  }
  return tagParts;
}

function refusePathLevelField(path: string, key: string): void {
  if (!HTTP_METHODS.has(key)) {
    throw new Error(
      `OpenAPI path ${path} has a path-level "${key}"; the parts carry operations only`,
    );
  }
}

function tagPartFor(
  tag: string,
  tagParts: Map<string, TagPart>,
  fileOwners: Map<string, string>,
): TagPart {
  const existing = tagParts.get(tag);
  if (existing !== undefined) return existing;
  const fileName = openApiPartFileName(tag);
  const owner =
    fileName === SHARED_OPENAPI_PART ? "_shared" : fileOwners.get(fileName);
  if (owner !== undefined) {
    throw new Error(
      `OpenAPI tags "${owner}" and "${tag}" would share ${fileName}`,
    );
  }
  fileOwners.set(fileName, tag);
  const created: TagPart = { tag, paths: {}, components: { schemas: {} } };
  tagParts.set(tag, created);
  return created;
}

/**
 * Moves each schema reached from exactly one tag into that tag's part and
 * returns the rest, the shared ones.
 */
function placeSchemas(
  schemas: Schemas,
  tagParts: Map<string, TagPart>,
): Schemas {
  const tagsReaching = new Map<string, Set<string>>();
  for (const part of tagParts.values()) {
    for (const name of schemasReachedFrom(part.paths, schemas)) {
      const reaching = tagsReaching.get(name) ?? new Set<string>();
      reaching.add(part.tag);
      tagsReaching.set(name, reaching);
    }
  }
  const shared: Schemas = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const owner = soleOwner(tagsReaching.get(name), tagParts);
    if (owner === undefined) {
      shared[name] = schema;
    } else {
      owner.components.schemas[name] = schema;
    }
  }
  return shared;
}

function soleOwner(
  reaching: ReadonlySet<string> | undefined,
  tagParts: ReadonlyMap<string, TagPart>,
): TagPart | undefined {
  if (reaching?.size !== 1) return undefined;
  const [tag] = reaching;
  return tag === undefined ? undefined : tagParts.get(tag);
}

/** Every component schema `node` reaches through `$ref`, transitively. */
function schemasReachedFrom(node: unknown, schemas: Schemas): Set<string> {
  const reached = new Set<string>();
  const pending: unknown[] = [node];
  while (pending.length > 0) {
    for (const [key, value] of childEntries(pending.pop())) {
      const name = key === "$ref" ? refName(value) : undefined;
      if (name === undefined) {
        pending.push(value);
      } else if (!reached.has(name) && name in schemas) {
        reached.add(name);
        pending.push(schemas[name]);
      }
    }
  }
  return reached;
}

function childEntries(node: unknown): [string, unknown][] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node);
}

function refName(value: unknown): string | undefined {
  return typeof value === "string" ? value.split("/").at(-1) : undefined;
}

export function assertArtifactTagFile(fileName: string, tag: string): void {
  const expected = openApiPartFileName(tag);
  if (expected !== fileName) {
    throw new Error(
      `${fileName} holds tag "${tag}", whose file is ${expected}`,
    );
  }
}

function addOperations(paths: Paths, partPaths: Paths): void {
  for (const [path, operations] of Object.entries(partPaths)) {
    const pathItem = paths[path] ?? {};
    for (const [method, operation] of Object.entries(operations)) {
      if (method in pathItem) {
        throw new Error(
          `${method.toUpperCase()} ${path} is in two OpenAPI parts`,
        );
      }
      pathItem[method] = operation;
    }
    paths[path] = pathItem;
  }
}

function addSchemas(schemas: Schemas, partSchemas: Schemas): void {
  for (const [name, schema] of Object.entries(partSchemas)) {
    if (name in schemas) {
      throw new Error(`schema ${name} is in two OpenAPI parts`);
    }
    schemas[name] = schema;
  }
}

function sortedByKey<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([first], [second]) =>
      byCodePoint(first, second),
    ),
  );
}
