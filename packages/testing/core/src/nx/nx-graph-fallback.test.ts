import { describe, expect, it } from "vitest";
import type { NxProject } from "./import-nx-types.js";
import type { JsonValue } from "./json-values.js";
import { parseNxGraphFallbackDependencies } from "./nx-graph-fallback.js";

/**
 * The headline refusal of the importer: an Nx graph shape this package does not
 * understand stops the import. A fallback that silently missed an edge would
 * under-test a change, so every unrecognized shape below must throw rather than
 * produce a narrower answer.
 */

const projects: readonly NxProject[] = [
  { name: "app", id: "nx-61-70-70", root: "apps/app", targets: [] },
  { name: "util", id: "nx-75-74-69-6c", root: "libs/util", targets: [] },
];

describe("parseNxGraphFallbackDependencies", () => {
  it("reads a source-agreeing edge as a fallback dependency", () => {
    const fallback = parseNxGraphFallbackDependencies(
      graph({
        app: [{ source: "app", target: "util", type: "static" }],
        util: [],
      }),
      projects,
    );

    expect(fallback.get("app")).toEqual(["nx-75-74-69-6c"]);
    expect(fallback.get("util")).toEqual([]);
  });

  it("refuses graph output that is not a JSON object", () => {
    const notObjects: readonly JsonValue[] = ["graph", 7, null, true, []];
    for (const notAnObject of notObjects) {
      expect(() => parseNxGraphFallbackDependencies(notAnObject, projects)).toThrow(
        "graph output must be a JSON object",
      );
    }
  });

  it("refuses graph output with no top-level graph object", () => {
    for (const missing of [{}, { graph: [] }, { graph: "nodes" }]) {
      expect(() => parseNxGraphFallbackDependencies(missing, projects)).toThrow("expected top-level graph object");
    }
  });

  it("refuses a graph missing either nodes or dependencies", () => {
    for (const body of [
      { nodes: { app: {} } },
      { dependencies: { app: [] } },
      { nodes: [], dependencies: {} },
      { nodes: {}, dependencies: [] },
    ]) {
      expect(() => parseNxGraphFallbackDependencies({ graph: body }, projects)).toThrow(
        "expected graph.nodes and graph.dependencies objects",
      );
    }
  });

  it("refuses a project the graph does not describe as an object node", () => {
    expect(() =>
      parseNxGraphFallbackDependencies({ graph: { nodes: { util: { name: "util" } }, dependencies: {} } }, projects),
    ).toThrow("graph.nodes is missing object node app");
  });

  it("refuses a project whose declared edges are not an array", () => {
    expect(() =>
      parseNxGraphFallbackDependencies(
        {
          graph: {
            nodes: { app: { name: "app" }, util: { name: "util" } },
            dependencies: { app: { target: "util" } },
          },
        },
        projects,
      ),
    ).toThrow("graph.dependencies is missing edge array app");
  });

  it("refuses a dependency edge that is not an object", () => {
    expect(() => parseNxGraphFallbackDependencies(graph({ app: ["util"], util: [] }), projects)).toThrow(
      "dependency edge for app is not an object",
    );
  });

  it("refuses an edge whose source disagrees with its containing key", () => {
    expect(() =>
      parseNxGraphFallbackDependencies(graph({ app: [{ source: "util", target: "app" }], util: [] }), projects),
    ).toThrow("dependency edge for app does not declare matching source and target");
  });

  it("refuses an edge that declares no target", () => {
    expect(() => parseNxGraphFallbackDependencies(graph({ app: [{ source: "app" }], util: [] }), projects)).toThrow(
      "dependency edge for app does not declare matching source and target",
    );
  });

  it("refuses a self dependency strict v1 cannot represent", () => {
    expect(() =>
      parseNxGraphFallbackDependencies(graph({ app: [{ source: "app", target: "app" }], util: [] }), projects),
    ).toThrow("project app has a self dependency");
  });

  it("ignores an edge pointing at a project outside the imported set", () => {
    const fallback = parseNxGraphFallbackDependencies(
      graph({
        app: [{ source: "app", target: "npm:vitest" }],
        util: [],
      }),
      projects,
    );

    expect(fallback.get("app")).toEqual([]);
  });
});

/** A graph body whose nodes are exactly the fixture projects. */
function graph(dependencies: Readonly<Record<string, JsonValue>>): JsonValue {
  return {
    graph: {
      nodes: { app: { name: "app" }, util: { name: "util" } },
      dependencies,
    },
  };
}
