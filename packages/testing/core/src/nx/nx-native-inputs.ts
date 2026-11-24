import { isRecord } from "../parse-guards.js";
import { pathIsInside } from "../path-ownership.js";
import { type NativeProject } from "./nx-native-graph.js";
import { expandInput, type InputExpansion } from "./nx-native-input-expansion.js";

const globalPolicyPaths = [
  "nx.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
];

/** What the scope covers and what it takes on faith, said in the words the coverage report prints. */
const scopeReason =
  "Scope: project root, transitive dependency and prerequisite roots, global policy files, and every expanded file input; plugin-inferred inputs assumed inside the project root.";

export type PrerequisiteTarget = {
  readonly project: NativeProject;
  readonly name: string;
};

export type InputScope = {
  readonly mode: "always" | "changed-files";
  readonly paths: readonly string[];
  /** Non-project-graph paths (global policy, shared inputs, build prerequisites) retained alongside reachability. */
  readonly extraPaths: readonly string[];
  /** Pure-check prerequisites (e.g. repo-wide lint gates) tracked via `dependsOn` instead of folded into inputs. */
  readonly checkPrerequisites: readonly PrerequisiteTarget[];
  readonly reason: string;
};

/** One target as its own project plus its Nx name, which is what `targetDefaults` is keyed by. */
type TargetIdentity = {
  readonly project: NativeProject;
  readonly name: string;
  readonly target: Readonly<Record<string, unknown>>;
};

export function inputScope(
  project: NativeProject,
  name: string,
  target: Readonly<Record<string, unknown>>,
  projects: ReadonlyMap<string, NativeProject>,
  configuration: unknown,
): InputScope {
  const context: InputExpansion = {
    paths: new Set(globalPolicyPaths),
    reasons: new Set(),
    projects,
    root: isRecord(configuration) ? configuration : {},
  };
  if (!isRecord(configuration)) context.reasons.add("unresolved Nx configuration");
  const dependencyRoots = new Set<string>();
  const visited = new Set<string>();
  visitProject(project, visited, context, dependencyRoots);
  const checkPrerequisites = new Map<string, PrerequisiteTarget>();
  visitTarget({ project, name, target }, visited, context, checkPrerequisites);
  const sortedPrerequisites = [...checkPrerequisites.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  if (context.reasons.size > 0) {
    return {
      mode: "always",
      paths: [],
      extraPaths: [],
      checkPrerequisites: sortedPrerequisites,
      reason: [...context.reasons].sort().join("; "),
    };
  }
  const paths = [...context.paths].sort();
  const extraPaths = paths.filter((candidate) => ![...dependencyRoots].some((root) => pathIsInside(candidate, root)));
  return {
    mode: "changed-files",
    paths,
    extraPaths,
    checkPrerequisites: sortedPrerequisites,
    reason: scopeReason,
  };
}

/**
 * A target and everything Nx runs before it. Output-producing prerequisites (such as `build` or
 * codegen targets) are folded into this target's inputs so changes to their sources invalidate the
 * consumer. Pure verification gates (check targets with no declared outputs, or explicit
 * `outputs: []`) are instead returned in `checkPrerequisites` so the manifest runs them once via
 * `dependsOn` without widening every unaffected project that references the gate.
 */
function visitTarget(
  start: TargetIdentity,
  visited: Set<string>,
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  const queue: TargetIdentity[] = [start];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index];
    if (next === undefined) continue;
    const identity = `${next.project.name}:${next.name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    visitProject(next.project, visited, context);
    expandDeclaredInputs(next, context);
    expandConfigurationInputs(next, context);
    collectPrerequisites(next, queue, context, checkPrerequisites);
  }
}

/**
 * The inputs Nx would use for this target: its own when it declares any, otherwise the matching
 * `targetDefaults`. Merging both would be wrong rather than conservative — a target's `inputs`
 * replace the defaults, so inheriting an input Nx would not apply can only make the scope refuse.
 */
function expandDeclaredInputs(identity: TargetIdentity, context: InputExpansion): void {
  const declared = identity.target["inputs"];
  if (declared !== undefined) {
    expandInputList(declared, identity.project, context);
    return;
  }
  for (const inputs of targetDefaultInputs(identity, context)) expandInputList(inputs, identity.project, context);
}

/**
 * A configuration is not a reason by itself; it only matters when it declares inputs the default
 * does not. Every configuration's inputs join the same set, which scopes the task as though any
 * of them could be the one that runs.
 */
function expandConfigurationInputs(identity: TargetIdentity, context: InputExpansion): void {
  const configurations = identity.target["configurations"];
  if (configurations === undefined) return;
  if (!isRecord(configurations)) {
    context.reasons.add("malformed target configurations");
    return;
  }
  for (const value of Object.values(configurations)) {
    if (isRecord(value)) expandInputList(value["inputs"], identity.project, context);
    else context.reasons.add("malformed target configurations");
  }
}

/** Nx keys `targetDefaults` by target name or by executor; a wildcard key is read as matching. */
function targetDefaultInputs(identity: TargetIdentity, context: InputExpansion): readonly unknown[] {
  const defaults = context.root["targetDefaults"];
  if (defaults === undefined) return [];
  if (!isRecord(defaults)) {
    context.reasons.add("malformed workspace targetDefaults");
    return [];
  }
  const matched: unknown[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    const applies = key === identity.name || key === identity.target["executor"] || key.includes("*");
    if (applies && isRecord(value) && value["inputs"] !== undefined) matched.push(value["inputs"]);
  }
  return matched;
}

function expandInputList(value: unknown, owner: NativeProject, context: InputExpansion): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    context.reasons.add("malformed target inputs");
    return;
  }
  for (const input of value) expandInput(input, owner, new Set(), context);
}

function collectPrerequisites(
  identity: TargetIdentity,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  const dependsOn = identity.target["dependsOn"];
  if (dependsOn === undefined) return;
  if (!Array.isArray(dependsOn)) {
    context.reasons.add("malformed task prerequisites");
    return;
  }
  for (const entry of dependsOn) addPrerequisite(entry, identity, queue, context, checkPrerequisites);
}

function addPrerequisite(
  entry: unknown,
  identity: TargetIdentity,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  if (typeof entry === "string") {
    if (entry.startsWith("^")) addDependencyPrerequisites(entry.slice(1), identity, queue, context, checkPrerequisites);
    else pushPrerequisite(identity.project, entry, queue, context, checkPrerequisites);
    return;
  }
  if (!isRecord(entry) || typeof entry["target"] !== "string") {
    context.reasons.add("unresolved task prerequisite");
    return;
  }
  addNamedPrerequisites(entry["projects"], entry["target"], identity, queue, context, checkPrerequisites);
}

function addNamedPrerequisites(
  projects: unknown,
  target: string,
  identity: TargetIdentity,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  if (projects === undefined || projects === "self") {
    pushPrerequisite(identity.project, target, queue, context, checkPrerequisites);
    return;
  }
  if (projects === "dependencies") {
    addDependencyPrerequisites(target, identity, queue, context, checkPrerequisites);
    return;
  }
  if (!Array.isArray(projects)) {
    context.reasons.add("unresolved task prerequisite");
    return;
  }
  for (const name of projects) addNamedPrerequisite(name, target, queue, context, checkPrerequisites);
}

/** A named project, never a tag selector: an entry the graph does not name cannot be located. */
function addNamedPrerequisite(
  name: unknown,
  target: string,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  const project = typeof name === "string" ? context.projects.get(name) : undefined;
  if (project) pushPrerequisite(project, target, queue, context, checkPrerequisites);
  else context.reasons.add("unresolved task prerequisite");
}

function addDependencyPrerequisites(
  target: string,
  identity: TargetIdentity,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  for (const dependency of identity.project.dependencies) {
    const project = context.projects.get(dependency);
    if (project) pushPrerequisite(project, target, queue, context, checkPrerequisites);
    else context.reasons.add("unresolved project dependency");
  }
}

/**
 * Pure-check prerequisites (no declared outputs, or explicit `outputs: []`) are tracked as
 * standalone `dependsOn` tasks so a repo-wide gate runs once instead of widening every consumer.
 * Output-producing prerequisites (e.g. `build` / codegen) stay folded into inputs.
 */
function pushPrerequisite(
  project: NativeProject,
  name: string,
  queue: TargetIdentity[],
  context: InputExpansion,
  checkPrerequisites: Map<string, PrerequisiteTarget>,
): void {
  const target = project.targets[name];
  if (isRecord(target) && target["continuous"] !== true && isPureCheckTarget(name, target, context)) {
    checkPrerequisites.set(`${project.name}:${name}`, { project, name });
    return;
  }
  queue.push({ project, name, target: isRecord(target) ? target : {} });
}

function isPureCheckTarget(name: string, target: Readonly<Record<string, unknown>>, context: InputExpansion): boolean {
  const declared = target["outputs"];
  if (declared !== undefined) return Array.isArray(declared) && declared.length === 0;
  const defaultResult = defaultOutputsState(name, target["executor"], context.root["targetDefaults"]);
  if (defaultResult === "has-outputs") return false;
  return defaultResult === "empty" || /^(lint|test|typecheck)(?:[:-]|$)/.test(name);
}

function defaultOutputsState(
  name: string,
  executor: unknown,
  defaults: unknown,
): "has-outputs" | "empty" | "unspecified" {
  if (!isRecord(defaults)) return "unspecified";
  let sawEmpty = false;
  for (const [key, value] of Object.entries(defaults)) {
    const outputs = matchingDefaultOutputs(key, value, name, executor);
    if (outputs === undefined) continue;
    if (!Array.isArray(outputs) || outputs.length > 0) return "has-outputs";
    sawEmpty = true;
  }
  return sawEmpty ? "empty" : "unspecified";
}

function matchingDefaultOutputs(key: string, value: unknown, name: string, executor: unknown): unknown {
  const applies = key === name || key === executor || key.includes("*");
  return applies && isRecord(value) ? value["outputs"] : undefined;
}

/**
 * External dependencies are not a reason: a version change reaches the lockfile and
 * `package.json`, which are workspace policy paths, and a project's own manifest is inside its
 * root. A project rooted at the workspace root is a reason, because it owns every path and this
 * scope cannot name what it would take to miss one.
 */
function visitProject(
  owner: NativeProject,
  visited: Set<string>,
  context: InputExpansion,
  dependencyRoots?: Set<string>,
): void {
  if (visited.has(owner.name)) return;
  visited.add(owner.name);
  if (owner.root === ".") {
    context.reasons.add("workspace-root project");
  } else {
    context.paths.add(owner.root);
    dependencyRoots?.add(owner.root);
  }
  expandInput("default", owner, new Set(), context);
  for (const dependency of owner.dependencies) {
    const next = context.projects.get(dependency);
    if (next) visitProject(next, visited, context, dependencyRoots);
    else context.reasons.add("unresolved project dependency");
  }
}
