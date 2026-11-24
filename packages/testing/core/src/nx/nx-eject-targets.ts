/**
 * Converts one resolved Nx graph target (including plugin-inferred Vitest,
 * ESLint, TypeScript, and `nx:run-commands` targets) into a standalone Dads
 * task with zero Nx runtime dependency, or audits honestly why it stays opaque.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "../parse-guards.js";
import type { TestingManifestFileNarrowing, TestingManifestTask } from "../testing-manifest.js";
import { dadsIdentifier, dadsTaskIdentifier } from "./dads-identifier.js";
import type { NativeProject } from "./nx-native-graph.js";
import { inputScope, type InputScope, type PrerequisiteTarget } from "./nx-native-inputs.js";
import { inspectVitestConfig } from "./nx-eject-vitest.js";

const vitestExecutors = new Set(["@nx/vite:test", "@nx/vitest:test"]);
const eslintExecutors = new Set(["@nx/eslint:lint", "@nx/linter:eslint"]);
const tscExecutors = new Set(["@nx/js:tsc"]);
const defaultVitestSuffixes = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];
const shellSyntaxPattern = /[|&;`$<>\n\r]/;
const envAssignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const rootLockfilePaths = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

export type EjectedTargetAudit = {
  readonly project: string;
  readonly target: string;
  readonly executor?: string;
  readonly classification: "converted" | "opaque" | "excluded";
  readonly reason: string;
  readonly taskId?: string;
  readonly impactMode?: "reachability" | "changed-files" | "always";
  readonly fileNarrowing?: boolean;
  readonly nxViteConfigPath?: string;
};

export type EjectedTargetResult = {
  readonly task?: TestingManifestTask;
  readonly audit: EjectedTargetAudit;
  readonly checkPrerequisites: readonly PrerequisiteTarget[];
  readonly nxViteConfigPath?: string;
};

type ExecutionPlan = {
  readonly execution: TestingManifestTask["execution"];
  readonly extraImpactPaths: readonly string[];
  readonly nxViteConfigPath?: string;
  readonly reason: string;
};

/** Materializes one Nx target into a standalone zero-Nx Dads task or an explicit audit. */
export function ejectTarget(input: {
  readonly workspaceRoot: string;
  readonly project: NativeProject;
  readonly name: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly projects: ReadonlyMap<string, NativeProject>;
  readonly nxConfiguration: unknown;
}): EjectedTargetResult {
  const { project, name, target } = input;
  const executor = typeof target["executor"] === "string" ? target["executor"] : undefined;
  const options = isRecord(target["options"]) ? target["options"] : {};
  const scope = inputScope(project, name, target, input.projects, input.nxConfiguration);
  const kind = ejectTaskKind(name);
  const plan = buildExecutionPlan({
    workspaceRoot: input.workspaceRoot,
    project,
    name,
    kind,
    executor,
    options,
    scope,
  });
  if (plan instanceof Error) {
    return {
      audit: {
        project: project.name,
        target: name,
        ...(executor === undefined ? {} : { executor }),
        classification: "opaque",
        reason: plan.message,
      },
      checkPrerequisites: [],
    };
  }
  const id = dadsTaskIdentifier(project.name, name);
  const impact = buildImpact(kind, scope, plan.extraImpactPaths);
  return {
    task: {
      id,
      project: dadsIdentifier(project.name),
      kind,
      execution: plan.execution,
      dependsOn: [],
      impact,
    },
    audit: {
      project: project.name,
      target: name,
      ...(executor === undefined ? {} : { executor }),
      classification: "converted",
      reason: plan.reason,
      taskId: id,
      impactMode: impact.mode,
      ...(plan.execution.fileNarrowing === undefined ? {} : { fileNarrowing: true }),
      ...(plan.nxViteConfigPath === undefined ? {} : { nxViteConfigPath: plan.nxViteConfigPath }),
    },
    checkPrerequisites: scope.checkPrerequisites,
    ...(plan.nxViteConfigPath === undefined ? {} : { nxViteConfigPath: plan.nxViteConfigPath }),
  };
}

function buildExecutionPlan(input: {
  readonly workspaceRoot: string;
  readonly project: NativeProject;
  readonly name: string;
  readonly kind: TestingManifestTask["kind"];
  readonly executor: string | undefined;
  readonly options: Readonly<Record<string, unknown>>;
  readonly scope: InputScope;
}): ExecutionPlan | Error {
  const { executor } = input;
  if (executor !== undefined && vitestExecutors.has(executor)) {
    return buildVitestPlan(input.workspaceRoot, input.project, input.options, input.scope);
  }
  if (executor !== undefined && eslintExecutors.has(executor)) {
    return buildEslintPlan(input.project, input.options);
  }
  if (executor !== undefined && tscExecutors.has(executor)) {
    return buildTscPlan(input.workspaceRoot, input.project, input.kind, input.options);
  }
  if (executor === "nx:run-commands") {
    return buildRunCommandsPlan(input.workspaceRoot, input.project, input.options, input.scope);
  }
  const label = executor ?? "unknown executor";
  return new Error(`Executor ${label} cannot be automatically ejected to a standalone command yet.`);
}

function buildVitestPlan(
  workspaceRoot: string,
  project: NativeProject,
  options: Readonly<Record<string, unknown>>,
  scope: InputScope,
): ExecutionPlan {
  const configured =
    typeof options["configFile"] === "string"
      ? options["configFile"]
      : typeof options["config"] === "string"
        ? options["config"]
        : undefined;
  const inspection = inspectVitestConfig(workspaceRoot, project.root, configured);
  const configArgs = configured === undefined ? [] : ["--config", resolvePlaceholders(configured, project.root)];
  const fileNarrowing = buildVitestNarrowing(scope, inspection.setupFiles, inspection.dynamicSetupFiles);
  const extraPaths = inspection.configPath === undefined ? [] : [inspection.configPath];
  return {
    execution: {
      executable: "npx",
      args: ["vitest", "run", ...configArgs],
      ...(project.root === "." || project.root === "" ? {} : { cwd: project.root }),
      ...(fileNarrowing === undefined ? {} : { fileNarrowing }),
    },
    extraImpactPaths: extraPaths,
    ...(inspection.usesNxViteTsPaths && inspection.configPath !== undefined
      ? { nxViteConfigPath: inspection.configPath }
      : {}),
    reason: vitestReason(fileNarrowing !== undefined, inspection.usesNxViteTsPaths),
  };
}

function buildVitestNarrowing(
  scope: InputScope,
  setupFiles: readonly string[],
  dynamicSetupFiles: boolean,
): TestingManifestFileNarrowing | undefined {
  if (scope.mode === "always" || dynamicSetupFiles) return undefined;
  return {
    suffixes: defaultVitestSuffixes,
    ...(setupFiles.length > 0 ? { setupFiles } : {}),
  };
}

function vitestReason(narrowed: boolean, usesNxVite: boolean): string {
  const narrowingText = narrowed ? "with file-level Vitest narrowing" : "at project reachability (dynamic setupFiles)";
  const viteText = usesNxVite ? "; config still uses nxViteTsPaths (pass --replace-nx-vite-paths)" : "";
  return `Ejected Vitest target to standalone 'npx vitest run' ${narrowingText}${viteText}.`;
}

function buildEslintPlan(project: NativeProject, options: Readonly<Record<string, unknown>>): ExecutionPlan {
  const rawPatterns = options["lintFilePatterns"];
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => resolvePlaceholders(entry, project.root))
    : [];
  const usesWorkspacePatterns = patterns.length > 0;
  return {
    execution: {
      executable: "npx",
      args: ["eslint", ...(usesWorkspacePatterns ? patterns : ["."])],
      ...(usesWorkspacePatterns || project.root === "." || project.root === "" ? {} : { cwd: project.root }),
    },
    extraImpactPaths: [],
    reason: "Ejected ESLint target to standalone 'npx eslint'.",
  };
}

function buildTscPlan(
  workspaceRoot: string,
  project: NativeProject,
  kind: TestingManifestTask["kind"],
  options: Readonly<Record<string, unknown>>,
): ExecutionPlan | Error {
  const tsConfig = resolveTscConfig(workspaceRoot, project.root, options["tsConfig"]);
  if (tsConfig === undefined) {
    return new Error(`Could not locate a tsconfig file for ${project.name}.`);
  }
  const args = kind === "typecheck" ? ["tsc", "--noEmit", "-p", tsConfig] : ["tsc", "-p", tsConfig];
  return {
    execution: { executable: "npx", args, cwd: "." },
    extraImpactPaths: [tsConfig],
    reason: `Ejected TypeScript target to standalone 'npx ${args.join(" ")}'.`,
  };
}

function resolveTscConfig(workspaceRoot: string, projectRoot: string, declared: unknown): string | undefined {
  if (typeof declared === "string" && declared.trim() !== "") {
    return resolvePlaceholders(declared, projectRoot);
  }
  for (const name of ["tsconfig.lib.json", "tsconfig.app.json", "tsconfig.json"]) {
    const candidate = projectRoot === "." ? name : path.posix.join(projectRoot, name);
    if (existsSync(path.join(workspaceRoot, candidate))) return candidate;
  }
  return undefined;
}

function buildRunCommandsPlan(
  workspaceRoot: string,
  project: NativeProject,
  options: Readonly<Record<string, unknown>>,
  scope: InputScope,
): ExecutionPlan | Error {
  const rawCommand = readRunCommand(options);
  if (rawCommand === undefined) return new Error("nx:run-commands target has no single command to eject.");
  const resolvedCommand = resolvePlaceholders(rawCommand, project.root);
  if (/[{][^}]+[}]/.test(resolvedCommand)) return new Error("Command contains unresolved Nx placeholders.");
  const resolvedCwd =
    typeof options["cwd"] === "string" ? resolvePlaceholders(options["cwd"], project.root).trim() : "";
  const strippedCwd = resolvedCwd.replace(/\/+$/, "");
  const rawCwd = strippedCwd === "" || strippedCwd === "." ? "." : strippedCwd;
  if (path.isAbsolute(rawCwd) || rawCwd.split("/").includes("..")) {
    return new Error("Command cwd escapes the workspace.");
  }
  if (invokesNxCommand(resolvedCommand)) {
    return new Error("Command invokes Nx directly and cannot become a zero-Nx task.");
  }
  return materializeRunCommand(workspaceRoot, project, resolvedCommand, rawCwd, scope);
}

const nonRunVitestSubcommands = new Set(["run", "bench", "list", "init", "--run", "--version", "-v", "--help", "-h"]);

function materializeRunCommand(
  workspaceRoot: string,
  project: NativeProject,
  resolvedCommand: string,
  cwd: string,
  scope: InputScope,
): ExecutionPlan | Error {
  if (shellSyntaxPattern.test(resolvedCommand)) {
    const isVitest = /(?:^|\s)vitest(?:\s|$)/.test(resolvedCommand);
    const vitestMeta = inspectRunCommandVitest(workspaceRoot, project.root, isVitest, scope);
    return {
      execution: { executable: resolvedCommand, args: [], ...(cwd === "." ? {} : { cwd }), shell: true },
      extraImpactPaths: vitestMeta.extraImpactPaths,
      ...(vitestMeta.nxViteConfigPath === undefined ? {} : { nxViteConfigPath: vitestMeta.nxViteConfigPath }),
      reason: "Ejected nx:run-commands shell command to standalone Dads task.",
    };
  }
  const argv = splitSimpleArgv(resolvedCommand);
  if (argv instanceof Error) return argv;
  const extracted = extractLeadingEnv(argv);
  if (extracted instanceof Error) return extracted;
  const normalized = normalizeEjectedVitest(extracted.executable, extracted.args);
  const vitestMeta = inspectRunCommandVitest(workspaceRoot, project.root, normalized.isVitest, scope);
  return {
    execution: {
      executable: normalized.executable,
      args: normalized.args,
      ...(cwd === "." ? {} : { cwd }),
      ...(Object.keys(extracted.env).length === 0 ? {} : { env: extracted.env }),
      ...(vitestMeta.fileNarrowing === undefined ? {} : { fileNarrowing: vitestMeta.fileNarrowing }),
    },
    extraImpactPaths: vitestMeta.extraImpactPaths,
    ...(vitestMeta.nxViteConfigPath === undefined ? {} : { nxViteConfigPath: vitestMeta.nxViteConfigPath }),
    reason: vitestMeta.reason,
  };
}

function normalizeEjectedVitest(
  executable: string,
  args: readonly string[],
): { readonly executable: string; readonly args: readonly string[]; readonly isVitest: boolean } {
  const isDirect = executable === "vitest" || executable.endsWith("/vitest");
  if (isDirect) {
    const hasSub = args.some((arg) => nonRunVitestSubcommands.has(arg));
    return { executable, args: hasSub ? args : ["run", ...args], isVitest: true };
  }
  if (executable === "npx" && args[0] === "vitest") {
    const rest = args.slice(1);
    const hasSub = rest.some((arg) => nonRunVitestSubcommands.has(arg));
    return { executable, args: hasSub ? args : ["vitest", "run", ...rest], isVitest: true };
  }
  return { executable, args, isVitest: false };
}

function extractLeadingEnv(argv: readonly string[]):
  | {
      readonly env: Readonly<Record<string, string>>;
      readonly executable: string;
      readonly args: readonly string[];
    }
  | Error {
  const env: Record<string, string> = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    const match = envAssignmentPattern.exec(token);
    if (match === null) break;
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) env[key] = value;
    index += 1;
  }
  const executable = argv[index];
  if (executable === undefined || executable.length === 0) {
    return new Error("Command contains only environment variable assignments.");
  }
  return { env, executable, args: argv.slice(index + 1) };
}

function inspectRunCommandVitest(
  workspaceRoot: string,
  projectRoot: string,
  isVitest: boolean,
  scope: InputScope,
): {
  readonly fileNarrowing?: TestingManifestFileNarrowing;
  readonly extraImpactPaths: readonly string[];
  readonly nxViteConfigPath?: string;
  readonly reason: string;
} {
  if (!isVitest) {
    return { extraImpactPaths: [], reason: "Ejected nx:run-commands recipe to standalone argv." };
  }
  const inspection = inspectVitestConfig(workspaceRoot, projectRoot);
  const fileNarrowing = buildVitestNarrowing(scope, inspection.setupFiles, inspection.dynamicSetupFiles);
  return {
    ...(fileNarrowing === undefined ? {} : { fileNarrowing }),
    extraImpactPaths: inspection.configPath === undefined ? [] : [inspection.configPath],
    ...(inspection.usesNxViteTsPaths && inspection.configPath !== undefined
      ? { nxViteConfigPath: inspection.configPath }
      : {}),
    reason: vitestReason(fileNarrowing !== undefined, inspection.usesNxViteTsPaths),
  };
}

function readRunCommand(options: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof options["command"] === "string" && options["command"].trim() !== "") return options["command"];
  const commands = options["commands"];
  if (Array.isArray(commands) && commands.length === 1) {
    const first: unknown = commands[0];
    if (typeof first === "string" && first.trim() !== "") return first;
    if (isRecord(first) && typeof first["command"] === "string" && first["command"].trim() !== "") {
      return first["command"];
    }
  }
  return undefined;
}

function buildImpact(
  kind: TestingManifestTask["kind"],
  scope: InputScope,
  extraPaths: readonly string[],
): { readonly mode: "reachability" | "changed-files" | "always"; readonly paths: readonly string[] } {
  if (scope.mode === "always") return { mode: "always", paths: [] };
  const useReachability = kind === "test" || kind === "typecheck" || kind === "lint" || kind === "build";
  const basePaths = useReachability ? scope.extraPaths : scope.paths;
  const merged = [...new Set([...basePaths, ...extraPaths])]
    .filter((entry) => !useReachability || !rootLockfilePaths.has(entry))
    .sort();
  return { mode: useReachability ? "reachability" : "changed-files", paths: merged };
}

function ejectTaskKind(name: string): TestingManifestTask["kind"] {
  if (/^test(?::|$)/.test(name)) return "test";
  if (/^typecheck(?::|-|$)/.test(name)) return "typecheck";
  if (/^lint(?::|-|$)/.test(name)) return "lint";
  return name === "build" ? "build" : "custom";
}

function resolvePlaceholders(value: string, projectRoot: string): string {
  return value.split("{workspaceRoot}").join(".").split("{projectRoot}").join(projectRoot);
}

function invokesNxCommand(command: string): boolean {
  return /(?:^|\s)(?:npx\s+)?(?:nx|@nx\/[\w-]+)(?:\s|$)/.test(command);
}

type ArgvScan = { readonly argv: string[]; readonly current: string; readonly quote: "'" | '"' | undefined };

function splitSimpleArgv(command: string): readonly string[] | Error {
  let state: ArgvScan = { argv: [], current: "", quote: undefined };
  for (const ch of command) state = stepArgvScan(state, ch);
  if (state.quote !== undefined) return new Error("Command contains an unclosed quote.");
  if (state.current !== "") state.argv.push(state.current);
  return state.argv.length === 0 ? new Error("Command is empty.") : state.argv;
}

function stepArgvScan(state: ArgvScan, ch: string): ArgvScan {
  if (state.quote !== undefined) {
    return ch === state.quote ? { ...state, quote: undefined } : { ...state, current: state.current + ch };
  }
  if (ch === "'" || ch === '"') return { ...state, quote: ch };
  if (/\s/.test(ch)) {
    if (state.current !== "") state.argv.push(state.current);
    return { ...state, current: "" };
  }
  return { ...state, current: state.current + ch };
}
