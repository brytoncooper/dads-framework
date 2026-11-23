import { z } from "zod";

import { byCodePoint } from "../openapi/logic/by-code-point.js";
import { assertArtifactTagFile, openApiPartFileName, SHARED_OPENAPI_PART } from "../openapi/logic/openapi-parts.js";

/**
 * A route catalog (a product's inventory of its route table: `routes`, each
 * with a `tag`, beside whatever else the product lists) as parts, for
 * committing it: one file per route tag holding that tag's routes, plus
 * `_shared.json` holding every other key. Two pull requests that add routes
 * under different tags then change different files instead of both
 * inserting into one sorted list.
 *
 * File names follow the OpenAPI parts (`openApiPartFileName`), so a tag's
 * catalog part and its OpenAPI part share a name. `bundleRouteCatalogParts`
 * puts the catalog back together byte for byte: `$comment` first, then
 * `routes` in `compareCatalogRoutes` order, then the shared keys in their
 * own order.
 */

/** The order a catalog lists its routes in: by path, then method. */
export function compareCatalogRoutes(
  first: { readonly path: string; readonly method: string },
  second: { readonly path: string; readonly method: string },
): number {
  return `${first.path} ${first.method}`.localeCompare(`${second.path} ${second.method}`);
}

// foreign-spec: a catalog route keeps every key its product serializes.
const catalogRouteSchema = z.looseObject({
  method: z.string(),
  path: z.string(),
  tag: z.string(),
});

type CatalogRoute = z.infer<typeof catalogRouteSchema>;

// foreign-spec: the catalog's other keys travel as the product wrote them.
const routeCatalogSchema = z.looseObject({
  routes: z.array(catalogRouteSchema),
});

// foreign-spec: the shared part is the catalog without its routes.
const sharedCatalogPartSchema = z.looseObject({});

const catalogTagPartSchema = z.strictObject({
  tag: z.string(),
  routes: z.array(catalogRouteSchema),
});

/** Splits a catalog into its parts, keyed by file name. */
export function splitRouteCatalog(catalog: unknown): ReadonlyMap<string, Record<string, unknown>> {
  const { routes, ...shared } = routeCatalogSchema.parse(catalog);
  const byTag = new Map<string, CatalogRoute[]>();
  for (const route of routes) {
    const tagRoutes = byTag.get(route.tag) ?? [];
    tagRoutes.push(route);
    byTag.set(route.tag, tagRoutes);
  }

  const parts = new Map<string, Record<string, unknown>>();
  parts.set(SHARED_OPENAPI_PART, shared);
  for (const tag of [...byTag.keys()].sort(byCodePoint)) {
    const fileName = openApiPartFileName(tag);
    if (parts.has(fileName)) {
      throw new Error(`catalog tag "${tag}" would share ${fileName}`);
    }
    const tagRoutes = byTag.get(tag) ?? [];
    parts.set(fileName, {
      tag,
      routes: [...tagRoutes].sort(compareCatalogRoutes),
    });
  }
  return parts;
}

/** Puts a catalog's parts back into the catalog, byte for byte. */
export function bundleRouteCatalogParts(parts: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const shared = sharedCatalogPartSchema.parse(parts.get(SHARED_OPENAPI_PART));
  const routes: CatalogRoute[] = [];
  for (const [fileName, value] of parts) {
    if (fileName === SHARED_OPENAPI_PART) continue;
    routes.push(...parseCatalogTagPart(fileName, value).routes);
  }
  const { $comment, ...rest } = shared;
  return {
    ...($comment === undefined ? {} : { $comment }),
    routes: routes.sort(compareCatalogRoutes),
    ...rest,
  };
}

function parseCatalogTagPart(fileName: string, value: unknown): z.infer<typeof catalogTagPartSchema> {
  const part = catalogTagPartSchema.parse(value);
  assertArtifactTagFile(fileName, part.tag);
  const stray = part.routes.find((route) => route.tag !== part.tag);
  if (stray !== undefined) {
    throw new Error(`${fileName} holds ${stray.method} ${stray.path}, tagged "${stray.tag}"`);
  }
  return part;
}
