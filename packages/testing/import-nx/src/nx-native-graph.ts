import { isRecord } from "./json-values.js";

export type NativeProject = {
  readonly name: string;
  readonly root: string;
  readonly targets: Readonly<Record<string, unknown>>;
  readonly namedInputs: unknown;
  readonly dependencies: readonly string[];
  readonly externalDependencies?: readonly string[];
};

type NativeGraph = {
  readonly nodes: Readonly<Record<string, unknown>>;
  readonly dependencies: Readonly<Record<string, unknown>>;
  readonly externalNames: ReadonlySet<string>;
};

/** Every project a collected graph declares; `nx-workspace-reader.ts` has `readProjects` for Nx's own answer. */
export function readNativeProjects(
  value: unknown,
): ReadonlyMap<string, NativeProject> {
  const graph = readGraph(value);
  const result = new Map<string, NativeProject>();
  const roots = new Set<string>();
  for (const [name, node] of Object.entries(graph.nodes).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const project = readNativeProject(name, node, graph);
    if (roots.has(project.root))
      throw new Error(`Ambiguous Nx project root ${project.root}.`);
    roots.add(project.root);
    result.set(name, project);
  }
  validateDependencySources(graph);
  return result;
}

function readGraph(value: unknown): NativeGraph {
  if (!isRecord(value)) throw new Error("Nx graph must be an object.");
  const graph = isRecord(value["graph"]) ? value["graph"] : value;
  if (!isRecord(graph["nodes"]) || !isRecord(graph["dependencies"]))
    throw new Error("Nx graph requires nodes and dependencies.");
  const externalNames = readExternalNames(graph["externalNodes"]);
  for (const name of externalNames) {
    if (Object.hasOwn(graph["nodes"], name))
      throw new Error(`Ambiguous external Nx identity ${name}.`);
  }
  return {
    nodes: graph["nodes"],
    dependencies: graph["dependencies"],
    externalNames,
  };
}

/** One graph node as a project; `nx-workspace-reader.ts` has `readProject` for Nx's own answer. */
function readNativeProject(
  name: string,
  node: unknown,
  graph: NativeGraph,
): NativeProject {
  const data = readProjectData(name, node);
  const root = projectRoot(data["root"]);
  if (!isRecord(data["targets"]))
    throw new Error(`Missing Nx targets for ${name}.`);
  const edges = graph.dependencies[name];
  if (!Array.isArray(edges))
    throw new Error(`Missing Nx dependency array for ${name}.`);
  const dependencies = new Set<string>();
  const externalDependencies = new Set<string>();
  for (const edge of edges) {
    const target = readNativeEdgeTarget(
      name,
      edge,
      graph,
      "Invalid Nx dependency",
    );
    if (graph.externalNames.has(target)) externalDependencies.add(target);
    else if (target !== name) dependencies.add(target);
  }
  return {
    name,
    root,
    targets: data["targets"],
    namedInputs: data["namedInputs"],
    dependencies: [...dependencies].sort(),
    externalDependencies: [...externalDependencies].sort(),
  };
}

function readProjectData(
  name: string,
  node: unknown,
): Readonly<Record<string, unknown>> {
  validateProjectName(name);
  if (!isRecord(node) || !isRecord(node["data"]))
    throw new Error(`Missing Nx project data for ${name}.`);
  const data = node["data"];
  if (
    data["name"] !== name ||
    (node["name"] !== undefined && node["name"] !== name)
  )
    throw new Error(`Nx project identity mismatch for ${name}.`);
  return data;
}

/** The project a collected graph edge points at; `nx-graph-fallback.ts` has `readEdgeTarget` for the imported graph. */
function readNativeEdgeTarget(
  source: string,
  edge: unknown,
  graph: NativeGraph,
  failure: string,
): string {
  if (
    !isRecord(edge) ||
    edge["source"] !== source ||
    typeof edge["target"] !== "string"
  )
    throw new Error(`${failure} for ${source}.`);
  const target = edge["target"];
  if (!Object.hasOwn(graph.nodes, target) && !graph.externalNames.has(target))
    throw new Error(`${failure} for ${source}.`);
  return target;
}

function validateDependencySources(graph: NativeGraph): void {
  for (const name of Object.keys(graph.dependencies)) {
    if (!Object.hasOwn(graph.nodes, name) && !graph.externalNames.has(name))
      throw new Error(`Unknown Nx dependency source ${name}.`);
    if (!graph.externalNames.has(name)) continue;
    const edges = graph.dependencies[name];
    if (!Array.isArray(edges))
      throw new Error(`Invalid external dependency array ${name}.`);
    for (const edge of edges)
      readNativeEdgeTarget(name, edge, graph, "Invalid external Nx dependency");
  }
}

function readExternalNames(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!isRecord(value)) throw new Error("Invalid Nx externalNodes.");
  for (const [name, node] of Object.entries(value)) {
    if (
      !name.trim() ||
      !isRecord(node) ||
      node["name"] !== name ||
      !isRecord(node["data"])
    )
      throw new Error(`Invalid external Nx node ${name}.`);
  }
  return new Set(Object.keys(value));
}

function projectRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error("Invalid Nx project root.");
  return (
    value
      .split("/")
      .filter((part) => part !== "." && part !== "")
      .join("/") || "."
  );
}

function validateProjectName(name: string): void {
  if (
    !name.trim() ||
    name !== name.trim() ||
    name.includes(":") ||
    /\s/.test(name) ||
    name.includes("\0")
  )
    throw new Error("Nx project identity is empty or ambiguous.");
}
