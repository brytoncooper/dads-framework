/**
 * What: a document split into per-tag parts bundles back to the same
 * document; each tag's operations and the schemas only it reaches land in
 * its file; an operation added under one tag changes only that file; the
 * split and the bundle refuse what they could not carry back.
 * Why: a product commits its OpenAPI document as these parts, so every
 * reader that bundles them must get the document the routes generate.
 */
import { describe, expect, it } from "vitest";

import { bundleOpenApiParts, openApiPartFileName, SHARED_OPENAPI_PART, splitOpenApiDocument } from "./openapi-parts.js";

function operation(tag: string, schemaName: string) {
  return {
    tags: [tag],
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      },
    },
  };
}

function documentWith(
  paths: Record<string, Record<string, unknown>>,
  schemas: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0" },
    tags: [{ name: "Health" }],
    paths,
    components: { schemas },
  };
}

const basePaths = {
  "/api/health": { get: operation("Health", "GetHealthResponse") },
  "/api/recipes": { get: operation("Products recipes", "GetRecipesResponse") },
};
const baseSchemas = {
  GetHealthResponse: { type: "object" },
  GetRecipesResponse: {
    type: "object",
    properties: { item: { $ref: "#/components/schemas/Recipe" } },
  },
  Recipe: { type: "object" },
};
const baseDocument = documentWith(basePaths, baseSchemas);

function partsAsJson(parts: ReadonlyMap<string, Record<string, unknown>>): Map<string, string> {
  return new Map([...parts].map(([fileName, part]) => [fileName, JSON.stringify(part)]));
}

describe("OpenAPI parts", () => {
  it("names a tag's file by its words", () => {
    expect(openApiPartFileName("Products recipes")).toBe("products-recipes.json");
    expect(openApiPartFileName("PLCs tags")).toBe("plcs-tags.json");
  });

  it("bundles back to the document it was split from", () => {
    expect(bundleOpenApiParts(splitOpenApiDocument(baseDocument))).toEqual(baseDocument);
  });

  it("puts each tag's operations, and the schemas only it reaches, in its own file", () => {
    const parts = splitOpenApiDocument(baseDocument);

    expect([...parts.keys()]).toEqual([SHARED_OPENAPI_PART, "health.json", "products-recipes.json"]);
    expect(parts.get("products-recipes.json")).toHaveProperty(["components", "schemas", "Recipe"]);
    expect(parts.get("health.json")).not.toHaveProperty(["paths", "/api/recipes"]);
  });

  it("puts a schema two tags reach in the shared file", () => {
    const parts = splitOpenApiDocument(
      documentWith(
        {
          "/api/a": { get: operation("A", "Shared") },
          "/api/b": { get: operation("B", "Shared") },
        },
        { Shared: { type: "object" } },
      ),
    );

    expect(parts.get(SHARED_OPENAPI_PART)).toHaveProperty(["components", "schemas", "Shared"]);
  });

  it("changes only the added operation's part when an operation is added under one tag", () => {
    const before = partsAsJson(splitOpenApiDocument(baseDocument));
    const after = partsAsJson(
      splitOpenApiDocument(
        documentWith(
          {
            ...basePaths,
            "/api/recipes/archived": {
              get: operation("Products recipes", "GetArchivedRecipesResponse"),
            },
          },
          {
            ...baseSchemas,
            GetArchivedRecipesResponse: { type: "object" },
          },
        ),
      ),
    );

    const changed = [...after.keys()].filter((fileName) => before.get(fileName) !== after.get(fileName));
    expect(changed).toEqual(["products-recipes.json"]);
  });

  it("refuses two tags that would write one file", () => {
    const document = documentWith(
      {
        "/api/a": { get: operation("Site sync", "A") },
        "/api/b": { get: operation("Site-sync", "B") },
      },
      { A: {}, B: {} },
    );

    expect(() => splitOpenApiDocument(document)).toThrow(/share site-sync/);
  });

  it("refuses an operation that two parts both define", () => {
    const parts = splitOpenApiDocument(baseDocument);
    const doubled = new Map<string, unknown>(parts);
    doubled.set("health-copy.json", {
      ...parts.get("health.json"),
      tag: "Health copy",
    });

    expect(() => bundleOpenApiParts(doubled)).toThrow(/two OpenAPI parts/);
  });
});
