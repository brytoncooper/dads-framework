import { isRecord } from "../parse-guards.js";
import { type NativeProject } from "./nx-native-graph.js";

export type InputExpansion = {
  readonly root: Readonly<Record<string, unknown>>;
  readonly projects: ReadonlyMap<string, NativeProject>;
  readonly paths: Set<string>;
  readonly reasons: Set<string>;
};

export function expandInput(
  value: unknown,
  owner: NativeProject,
  stack: ReadonlySet<string>,
  context: InputExpansion,
): void {
  if (typeof value !== "string") {
    expandObjectInput(value, owner, stack, context);
    return;
  }
  if (value.startsWith("!")) return;
  if (value.startsWith("^")) {
    expandDependencyInput(value.slice(1), owner, stack, context);
    return;
  }
  if (
    value.startsWith("{projectRoot}") ||
    value.startsWith("{workspaceRoot}")
  ) {
    expandFileInput(value, owner, context);
    return;
  }
  expandNamedInput(value, owner, stack, context);
}

/**
 * Nx writes every input that is not a glob as an object. Two of those shapes name a file this
 * scope can locate, and two are already covered by paths the scope always holds: the lockfiles and
 * `package.json` in the workspace policy paths answer for an external dependency, and a dependent
 * task's output files are produced from that task's own project, whose root is in scope because
 * `nx-native-inputs.ts#visitProject` walks every dependency and every prerequisite. Every other
 * shape — `runtime`, `env`, a cross-project fileset — names something no changed path can be
 * compared against, so it refuses.
 */
function expandObjectInput(
  value: unknown,
  owner: NativeProject,
  stack: ReadonlySet<string>,
  context: InputExpansion,
): void {
  if (!isRecord(value)) {
    context.reasons.add("non-file or unresolved input");
    return;
  }
  if (
    Object.hasOwn(value, "externalDependencies") ||
    Object.hasOwn(value, "dependentTasksOutputFiles")
  )
    return;
  const named = value["fileset"] ?? value["json"];
  if (typeof named !== "string") {
    context.reasons.add("non-file or unresolved input");
    return;
  }
  expandInput(named, owner, stack, context);
}

function expandDependencyInput(
  value: string,
  owner: NativeProject,
  stack: ReadonlySet<string>,
  context: InputExpansion,
): void {
  for (const dependency of owner.dependencies) {
    const next = context.projects.get(dependency);
    if (next) expandInput(value, next, stack, context);
    else context.reasons.add("unresolved project dependency");
  }
}

function expandFileInput(
  value: string,
  owner: NativeProject,
  context: InputExpansion,
): void {
  const substituted = value
    .replace(/^\{projectRoot\}/, owner.root)
    .replace(/^\{workspaceRoot\}/, ".");
  const prefix = literalPrefix(substituted);
  if (prefix === null) context.reasons.add("unresolved or escaping input path");
  else if (prefix === ".") context.reasons.add("workspace-wide input");
  else context.paths.add(prefix);
}

function expandNamedInput(
  value: string,
  owner: NativeProject,
  stack: ReadonlySet<string>,
  context: InputExpansion,
): void {
  const identity = `${owner.name}:${value}`;
  if (stack.has(identity)) {
    context.reasons.add("cyclic named input");
    return;
  }
  const named = namedInputs(owner, context);
  const definition = Object.hasOwn(named, value)
    ? named[value]
    : defaultDefinition(value);
  if (!Array.isArray(definition)) {
    context.reasons.add(`unresolved named input ${value}`);
    return;
  }
  const nested = new Set(stack);
  nested.add(identity);
  for (const input of definition) expandInput(input, owner, nested, context);
}

function namedInputs(
  owner: NativeProject,
  context: InputExpansion,
): Readonly<Record<string, unknown>> {
  const globalInputs = context.root["namedInputs"];
  if (globalInputs !== undefined && !isRecord(globalInputs))
    context.reasons.add("malformed workspace namedInputs");
  if (owner.namedInputs !== undefined && !isRecord(owner.namedInputs))
    context.reasons.add("malformed project namedInputs");
  return {
    ...(isRecord(globalInputs) ? globalInputs : {}),
    ...(isRecord(owner.namedInputs) ? owner.namedInputs : {}),
  };
}

function defaultDefinition(value: string): unknown {
  return value === "default" ? ["{projectRoot}/**/*"] : undefined;
}

function literalPrefix(value: string): string | null {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    return null;
  const normalized = value.replace(/^\.\//, "");
  const wildcard = normalized
    .split("")
    .findIndex((character) => "?*[]{}()+@!".includes(character));
  const prefix =
    wildcard < 0
      ? normalized
      : normalized.slice(0, wildcard).replace(/[^/]*$/, "");
  if (normalized.split("/").includes("..")) return null;
  const parts = prefix.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 ? "." : parts.join("/");
}
