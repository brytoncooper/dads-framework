/**
 * The one thing this importer keeps from the Nx project graph: which projects
 * a project falls back to when Dads cannot compute impact itself.
 *
 * Supports the JSON written by `nx graph --file=<path>` where
 * `graph.nodes[project]` is an object and `graph.dependencies[source]` is an
 * array of `{ source, target }` edges. An edge is interpreted only when its
 * source agrees with its containing dependency key, so the frozen Dads
 * fallback dependency is `source -> target` (source depends on target). Any
 * other shape is refused rather than guessed at: a fallback that silently
 * misses an edge would under-test a change, which is the one failure mode a
 * fallback exists to prevent.
 */
import type { NxProject } from "./import-nx-types.js";
import {
  isJsonArray,
  isJsonRecord,
  readOptionalString,
  readOptionalJsonRecord,
  type JsonRecord,
  type JsonValue,
} from "./json-values.js";

/** The two members of the graph this importer reads. */
type NxGraphBody = {
  readonly nodes: JsonRecord;
  readonly dependencies: JsonRecord;
};

/** Each project's fallback dependencies, by project name. */
export function parseNxGraphFallbackDependencies(
  graph: JsonValue,
  projects: readonly NxProject[],
): ReadonlyMap<string, readonly string[]> {
  const body = readGraphBody(graph);
  const byName = new Map(projects.map((project) => [project.name, project]));
  const fallback = new Map<string, readonly string[]>();
  for (const project of projects) {
    fallback.set(project.name, projectDependencies(body, byName, project));
  }
  return fallback;
}

/** The `graph.nodes` and `graph.dependencies` objects, or a refusal. */
function readGraphBody(graph: JsonValue): NxGraphBody {
  if (!isJsonRecord(graph)) throw new Error("Unsupported Nx graph shape: graph output must be a JSON object.");
  const graphBody = readOptionalJsonRecord(graph, "graph");
  if (!graphBody) throw new Error("Unsupported Nx graph shape: expected top-level graph object.");
  const nodes = readOptionalJsonRecord(graphBody, "nodes");
  const dependencies = readOptionalJsonRecord(graphBody, "dependencies");
  if (!nodes || !dependencies)
    throw new Error("Unsupported Nx graph shape: expected graph.nodes and graph.dependencies objects.");
  return { nodes, dependencies };
}

/** One project's fallback dependency ids, deduplicated and sorted. */
function projectDependencies(
  body: NxGraphBody,
  byName: ReadonlyMap<string, NxProject>,
  project: NxProject,
): readonly string[] {
  const dependencies = new Set<string>();
  for (const edge of readProjectEdges(body, project.name)) {
    const targetProject = byName.get(readEdgeTarget(edge, project.name));
    if (targetProject === undefined) continue;
    if (targetProject.id === project.id) {
      throw new Error(
        `Unsupported Nx graph shape: project ${project.name} has a self dependency that strict v1 cannot represent.`,
      );
    }
    dependencies.add(targetProject.id);
  }
  return [...dependencies].sort();
}

/** The declared edges leaving one project, or a refusal. */
function readProjectEdges(body: NxGraphBody, projectName: string): readonly JsonValue[] {
  if (!isJsonRecord(body.nodes[projectName])) {
    throw new Error(`Unsupported Nx graph shape: graph.nodes is missing object node ${projectName}.`);
  }
  const edges = body.dependencies[projectName];
  if (!isJsonArray(edges)) {
    throw new Error(`Unsupported Nx graph shape: graph.dependencies is missing edge array ${projectName}.`);
  }
  return edges;
}

/** The project one edge points at, or a refusal naming what was missing; `nx-native-graph.ts` has `readNativeEdgeTarget`. */
function readEdgeTarget(edge: JsonValue, projectName: string): string {
  if (!isJsonRecord(edge))
    throw new Error(`Unsupported Nx graph shape: dependency edge for ${projectName} is not an object.`);
  const source = readOptionalString(edge, "source");
  const target = readOptionalString(edge, "target");
  if (source !== projectName || target === undefined) {
    throw new Error(
      `Unsupported Nx graph shape: dependency edge for ${projectName} does not declare matching source and target.`,
    );
  }
  return target;
}
