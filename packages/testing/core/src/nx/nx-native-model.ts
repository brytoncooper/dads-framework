import { dadsIdentifier } from "./dads-identifier.js";
import { isRecord } from "../parse-guards.js";
import { readNativeProjects, type NativeProject } from "./nx-native-graph.js";
import process from "node:process";
import type { TestingManifest, TestingManifestTask } from "../testing-manifest.js";
import { inputScope, type PrerequisiteTarget } from "./nx-native-inputs.js";

export type NativeNxCoverage = {
  readonly projects: number;
  readonly targets: number;
  readonly registered: number;
  readonly excluded: number;
  readonly always: number;
  readonly tasks: readonly {
    readonly project: string;
    readonly target: string;
    readonly classification: "registered" | "excluded";
    readonly reason: string;
    readonly taskId?: string;
    readonly impactMode?: "reachability" | "changed-files" | "always";
  }[];
};

type BuildInput = {
  readonly graph: unknown;
  readonly nxConfiguration: unknown;
  readonly nxCli: string;
  readonly targetNames?: readonly string[];
};
type TaskAudit = NativeNxCoverage["tasks"][number];
type BuiltTaskEntry = {
  readonly task: TestingManifestTask;
  readonly audit: TaskAudit;
  readonly checkPrerequisites: readonly PrerequisiteTarget[];
};

const reachabilityReason =
  "Scope: symbol-level reachability across project and transitive dependency roots, plus global policy files, build prerequisites, and expanded non-graph inputs; plugin-inferred inputs assumed inside the project root.";

export function buildNativeNxManifest(input: BuildInput): {
  readonly manifest: TestingManifest;
  readonly coverage: NativeNxCoverage;
} {
  const projects = readNativeProjects(input.graph);
  if (input.targetNames?.some((name) => !name.trim())) throw new Error("Requested target names must be nonempty.");
  const entries = new Map<string, BuiltTaskEntry>();
  const auditsByKey = new Map<string, TaskAudit>();
  const pendingPrerequisites = registerSelectedTargets(projects, input, entries, auditsByKey);
  registerCheckPrerequisites(pendingPrerequisites, projects, input, entries, auditsByKey);

  const tasks = wirePrerequisiteDependencies(entries);
  if (tasks.length === 0) throw new Error("No non-continuous verification targets were registered.");
  const audits = [...auditsByKey.values()];
  return {
    manifest: {
      schemaVersion: 1,
      workspace: {
        root: ".",
        fullFallback: { taskIds: tasks.map((task) => task.id).sort() },
      },
      projects: [...projects.values()].map((project) => ({
        id: dadsIdentifier(project.name),
        root: project.root,
        fallbackDependencies: project.dependencies.map(dadsIdentifier).sort(),
      })),
      tasks,
    },
    coverage: {
      projects: projects.size,
      targets: audits.length,
      registered: tasks.length,
      excluded: audits.length - tasks.length,
      always: tasks.filter((task) => task.impact.mode === "always").length,
      tasks: audits,
    },
  };
}

function registerSelectedTargets(
  projects: ReadonlyMap<string, NativeProject>,
  input: BuildInput,
  entries: Map<string, BuiltTaskEntry>,
  auditsByKey: Map<string, TaskAudit>,
): PrerequisiteTarget[] {
  const pending: PrerequisiteTarget[] = [];
  for (const project of projects.values()) {
    for (const [name, value] of Object.entries(project.targets).sort(([left], [right]) => left.localeCompare(right))) {
      const target = readTarget(project.name, name, value);
      const key = `${project.name}:${name}`;
      const chosen = input.targetNames === undefined ? verificationTarget(name) : input.targetNames.includes(name);
      if (target["continuous"] === true || !chosen) {
        auditsByKey.set(key, excludedAudit(project.name, name, target["continuous"] === true));
        continue;
      }
      const built = buildTaskEntry(project, name, target, projects, input);
      entries.set(built.task.id, built);
      auditsByKey.set(key, built.audit);
      pending.push(...built.checkPrerequisites);
    }
  }
  return pending;
}

function excludedAudit(project: string, target: string, continuous: boolean): TaskAudit {
  return {
    project,
    target,
    classification: "excluded",
    reason: continuous ? "Continuous targets are excluded." : "Outside requested verification scope.",
  };
}

function registerCheckPrerequisites(
  pendingPrerequisites: PrerequisiteTarget[],
  projects: ReadonlyMap<string, NativeProject>,
  input: BuildInput,
  entries: Map<string, BuiltTaskEntry>,
  auditsByKey: Map<string, TaskAudit>,
): void {
  for (let index = 0; index < pendingPrerequisites.length; index += 1) {
    const prerequisite = pendingPrerequisites[index];
    if (prerequisite === undefined) continue;
    const id = taskIdentifier(prerequisite.project.name, prerequisite.name);
    if (entries.has(id)) continue;
    const rawTarget = prerequisite.project.targets[prerequisite.name];
    if (!isRecord(rawTarget)) continue;
    const target = readTarget(prerequisite.project.name, prerequisite.name, rawTarget);
    if (target["continuous"] === true) continue;
    const built = buildTaskEntry(prerequisite.project, prerequisite.name, target, projects, input);
    entries.set(built.task.id, built);
    auditsByKey.set(`${prerequisite.project.name}:${prerequisite.name}`, built.audit);
    pendingPrerequisites.push(...built.checkPrerequisites);
  }
}

function buildTaskEntry(
  project: NativeProject,
  name: string,
  target: Readonly<Record<string, unknown>>,
  projects: ReadonlyMap<string, NativeProject>,
  input: BuildInput,
): BuiltTaskEntry {
  const id = taskIdentifier(project.name, name);
  const kind = nativeTaskKind(name);
  const scope = inputScope(project, name, target, projects, input.nxConfiguration);
  const useReachability = scope.mode !== "always" && usesReachability(kind);
  const mode = scope.mode === "always" ? "always" : useReachability ? "reachability" : "changed-files";
  const paths = scope.mode === "always" ? [] : useReachability ? scope.extraPaths : scope.paths;
  const reason = useReachability ? reachabilityReason : scope.reason;
  return {
    task: {
      id,
      project: dadsIdentifier(project.name),
      kind,
      execution: {
        executable: process.execPath,
        args: [input.nxCli, "run", `--project=${project.name}`, `--target=${name}`],
        cwd: ".",
      },
      dependsOn: [],
      impact: { mode, paths },
    },
    audit: {
      project: project.name,
      target: name,
      classification: "registered",
      reason,
      taskId: id,
      impactMode: mode,
    },
    checkPrerequisites: scope.checkPrerequisites,
  };
}

function wirePrerequisiteDependencies(entries: ReadonlyMap<string, BuiltTaskEntry>): readonly TestingManifestTask[] {
  const edges = new Map<string, string[]>();
  const tasks: TestingManifestTask[] = [];
  for (const entry of entries.values()) {
    const dependsOn: string[] = [];
    let cyclic = false;
    for (const prerequisite of entry.checkPrerequisites) {
      const targetId = taskIdentifier(prerequisite.project.name, prerequisite.name);
      if (targetId === entry.task.id || !entries.has(targetId)) continue;
      if (reachesTask(targetId, entry.task.id, edges)) {
        cyclic = true;
        continue;
      }
      if (!dependsOn.includes(targetId)) dependsOn.push(targetId);
    }
    dependsOn.sort();
    edges.set(entry.task.id, dependsOn);
    tasks.push({
      ...entry.task,
      dependsOn,
      ...(cyclic ? { impact: { mode: "always" as const, paths: [] } } : {}),
    });
  }
  return tasks;
}

export function reachesTask(start: string, target: string, edges: ReadonlyMap<string, readonly string[]>): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current === target) return true;
    for (const next of edges.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

function taskIdentifier(project: string, target: string): string {
  return `${dadsIdentifier(project)}:${dadsIdentifier(target)}`;
}

function usesReachability(kind: TestingManifestTask["kind"]): boolean {
  return kind === "test" || kind === "typecheck" || kind === "build";
}

function readTarget(project: string, name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!name.trim() || name !== name.trim() || /\s/.test(name) || name.includes("\0") || !isRecord(value))
    throw new Error(`Invalid target ${project}:${name}.`);
  if (value["continuous"] !== undefined && typeof value["continuous"] !== "boolean")
    throw new Error(`Invalid continuous flag for ${project}:${name}.`);
  return value;
}

function verificationTarget(name: string): boolean {
  return /^(test|typecheck|lint|build)$/.test(name) || /^(test:|typecheck[:-]|lint[:-])/.test(name);
}

/** What an anchored target name says the task is for; `nx-target-conversion.ts` has `taskKind` for a substring reading. */
function nativeTaskKind(name: string): TestingManifestTask["kind"] {
  if (/^test(?::|$)/.test(name)) return "test";
  if (/^typecheck(?::|-|$)/.test(name)) return "typecheck";
  if (/^lint(?::|-|$)/.test(name)) return "lint";
  return name === "build" ? "build" : "custom";
}
