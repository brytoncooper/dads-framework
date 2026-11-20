import { dadsIdentifier } from "./dads-identifier.js";
import { isRecord } from "./json-values.js";
import { readNativeProjects, type NativeProject } from "./nx-native-graph.js";
import process from "node:process";
import type {
  TestingManifest,
  TestingManifestTask,
} from "@dads-framework/testing";
import { inputScope } from "./nx-native-inputs.js";

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
    readonly impactMode?: "changed-files" | "always";
  }[];
};

type BuildInput = {
  readonly graph: unknown;
  readonly nxConfiguration: unknown;
  readonly nxCli: string;
  readonly targetNames?: readonly string[];
};
type TaskAudit = NativeNxCoverage["tasks"][number];
type TaskRegistration = {
  readonly task?: TestingManifestTask;
  readonly audit: TaskAudit;
};

export function buildNativeNxManifest(input: BuildInput): {
  readonly manifest: TestingManifest;
  readonly coverage: NativeNxCoverage;
} {
  const projects = readNativeProjects(input.graph);
  if (input.targetNames?.some((name) => !name.trim()))
    throw new Error("Requested target names must be nonempty.");
  const tasks: TestingManifestTask[] = [];
  const audits: TaskAudit[] = [];
  for (const project of projects.values()) {
    for (const [name, value] of Object.entries(project.targets).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const registration = registerTarget(
        project,
        name,
        value,
        projects,
        input,
      );
      audits.push(registration.audit);
      if (registration.task) tasks.push(registration.task);
    }
  }
  if (tasks.length === 0)
    throw new Error("No non-continuous verification targets were registered.");
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

function registerTarget(
  project: NativeProject,
  name: string,
  value: unknown,
  projects: ReadonlyMap<string, NativeProject>,
  input: BuildInput,
): TaskRegistration {
  const target = readTarget(project.name, name, value);
  const chosen =
    input.targetNames === undefined
      ? verificationTarget(name)
      : input.targetNames.includes(name);
  if (target["continuous"] === true || !chosen) {
    return {
      audit: {
        project: project.name,
        target: name,
        classification: "excluded",
        reason:
          target["continuous"] === true
            ? "Continuous targets are excluded."
            : "Outside requested verification scope.",
      },
    };
  }
  const id = `${dadsIdentifier(project.name)}:${dadsIdentifier(name)}`;
  const impact = inputScope(
    project,
    name,
    target,
    projects,
    input.nxConfiguration,
  );
  return {
    task: {
      id,
      project: dadsIdentifier(project.name),
      kind: nativeTaskKind(name),
      execution: {
        executable: process.execPath,
        args: [
          input.nxCli,
          "run",
          `--project=${project.name}`,
          `--target=${name}`,
        ],
        cwd: ".",
      },
      dependsOn: [],
      impact: { mode: impact.mode, paths: impact.paths },
    },
    audit: {
      project: project.name,
      target: name,
      classification: "registered",
      reason: impact.reason,
      taskId: id,
      impactMode: impact.mode,
    },
  };
}

function readTarget(
  project: string,
  name: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !name.trim() ||
    name !== name.trim() ||
    /\s/.test(name) ||
    name.includes("\0") ||
    !isRecord(value)
  )
    throw new Error(`Invalid target ${project}:${name}.`);
  if (
    value["continuous"] !== undefined &&
    typeof value["continuous"] !== "boolean"
  )
    throw new Error(`Invalid continuous flag for ${project}:${name}.`);
  return value;
}

function verificationTarget(name: string): boolean {
  return (
    /^(test|typecheck|lint|build)$/.test(name) ||
    /^(test:|typecheck[:-]|lint[:-])/.test(name)
  );
}

/** What an anchored target name says the task is for; `nx-target-conversion.ts` has `taskKind` for a substring reading. */
function nativeTaskKind(name: string): TestingManifestTask["kind"] {
  if (/^test(?::|$)/.test(name)) return "test";
  if (/^typecheck(?::|-|$)/.test(name)) return "typecheck";
  if (/^lint(?::|-|$)/.test(name)) return "lint";
  return name === "build" ? "build" : "custom";
}
