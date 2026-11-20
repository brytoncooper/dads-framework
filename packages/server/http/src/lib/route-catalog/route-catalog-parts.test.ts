/**
 * What: a route catalog split into per-tag parts bundles back byte for byte;
 * each tag's routes land in its file and every other key in the shared one;
 * a route added under one tag changes only that file; a misfiled route is
 * refused.
 * Why: a product commits its catalog as these parts, and CI compares what
 * the generator writes against them.
 */
import { describe, expect, it } from "vitest";

import {
  bundleRouteCatalogParts,
  compareCatalogRoutes,
  splitRouteCatalog,
} from "./route-catalog-parts.js";

function route(method: string, path: string, tag: string) {
  return { method, path, tag, status: 200, site: "cloud_only" };
}

const baseRoutes = [
  route("GET", "/health", "Health"),
  route("GET", "/recipes", "Products recipes"),
  route("POST", "/recipes", "Products recipes"),
].sort(compareCatalogRoutes);

const baseCatalog = {
  $comment: "GENERATED",
  routes: baseRoutes,
  siteRootRoutes: [route("GET", "/docs/llms.txt", "Docs")],
  reactions: [{ eventName: "a", name: "b" }],
  domainConnections: [{ consumer: "x", provider: "y" }],
};

describe("route catalog parts", () => {
  it("bundles back to the catalog byte for byte, key order included", () => {
    const bundled = bundleRouteCatalogParts(splitRouteCatalog(baseCatalog));

    expect(JSON.stringify(bundled)).toBe(JSON.stringify(baseCatalog));
  });

  it("puts each tag's routes in its own file and the rest in the shared one", () => {
    const parts = splitRouteCatalog(baseCatalog);

    expect([...parts.keys()]).toEqual([
      "_shared.json",
      "health.json",
      "products-recipes.json",
    ]);
    expect(parts.get("_shared.json")).not.toHaveProperty("routes");
    expect(parts.get("_shared.json")).toHaveProperty("domainConnections");
    expect(parts.get("products-recipes.json")).toEqual({
      tag: "Products recipes",
      routes: [
        route("GET", "/recipes", "Products recipes"),
        route("POST", "/recipes", "Products recipes"),
      ],
    });
  });

  it("changes only the added route's part when a route is added under one tag", () => {
    const before = splitRouteCatalog(baseCatalog);
    const after = splitRouteCatalog({
      ...baseCatalog,
      routes: [
        ...baseRoutes,
        route("GET", "/recipes/archived", "Products recipes"),
      ],
    });

    const changed = [...after.keys()].filter(
      (fileName) =>
        JSON.stringify(before.get(fileName)) !==
        JSON.stringify(after.get(fileName)),
    );
    expect(changed).toEqual(["products-recipes.json"]);
  });

  it("refuses a route filed under another tag's part", () => {
    const parts = new Map<string, unknown>(splitRouteCatalog(baseCatalog));
    parts.set("health.json", {
      tag: "Health",
      routes: [route("GET", "/recipes/stray", "Products recipes")],
    });

    expect(() => bundleRouteCatalogParts(parts)).toThrow(
      /tagged "Products recipes"/,
    );
  });
});
