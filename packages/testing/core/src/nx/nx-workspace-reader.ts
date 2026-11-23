/**
 * Reading an Nx workspace, and nothing more.
 *
 * Everything this module knows about Nx it learned by running Nx's own
 * machine-readable commands against a workspace that is clean and committed,
 * so an import always names the exact tree it read. Nothing here decides what
 * a target becomes; it only turns Nx's JSON into the `Nx*` shapes the rest of
 * the package reasons about, and refuses loudly when Nx answers in a shape
 * this importer does not recognize.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isRecord, isUnknownArray } from "../parse-guards.js";
import { dadsIdentifier } from "./dads-identifier.js";
import { parseNxConfiguration } from "./nx-installation.js";
import type { GitSnapshot, NxCommandRunner, NxProject, NxTarget } from "./import-nx-types.js";
import {
  isJsonRecord,
  parseJson,
  readOptionalBoolean,
  readOptionalString,
  readOptionalJsonRecord,
  type JsonRecord,
  type JsonValue,
} from "./json-values.js";

/** Target fields this importer resolves; every other field is dropped. */
const carriedTargetFields = ["executor", "options", "continuous"];
const carriedOptionFields = ["command", "cwd"];
const executionAffectingFields = ["dependsOn", "defaultConfiguration", "configurations"];

// --- The source tree -----------------------------------------------------

/**
 * Refuses any workspace whose HEAD is not exactly the immutable object ID the
 * caller approved. An import records a SHA; a dirty tree would make that
 * record a lie, so the check happens before Nx is asked anything at all.
 */
export async function requireCleanCommittedWorkspace(
  workspaceRoot: string,
  expectedGitSha: string,
  runner: NxCommandRunner,
): Promise<GitSnapshot> {
  const expected = readApprovedSha(expectedGitSha);
  const status = await runner({
    executable: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: workspaceRoot,
  });
  if (status.stdout.trim() !== "") {
    throw new Error("Refusing Nx import: source workspace has uncommitted or untracked changes.");
  }
  const revision = await runner({
    executable: "git",
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: workspaceRoot,
  });
  const resolved = revision.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) {
    throw new Error("Refusing Nx import: source workspace does not have an immutable Git HEAD SHA.");
  }
  if (resolved !== expected) {
    throw new Error(`Refusing Nx import: expected Git SHA ${expected} does not match clean HEAD ${resolved}.`);
  }
  return { expected, resolved };
}

/** The caller's SHA, normalized, or a refusal naming what was wrong with it. */
function readApprovedSha(expectedGitSha: string): string {
  if (typeof expectedGitSha !== "string") {
    throw new Error("Refusing Nx import: expectedGitSha is required and must be a full Git object ID.");
  }
  const expected = expectedGitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(expected)) {
    throw new Error("Refusing Nx import: expectedGitSha must be a full 40- or 64-character Git object ID.");
  }
  return expected;
}

// --- Nx's own answers ----------------------------------------------------

/** The Node, npm, and Nx versions the import was taken under. */
export async function readVersions(
  workspaceRoot: string,
  nxExecutable: string,
  runner: NxCommandRunner,
): Promise<Readonly<Record<string, string>>> {
  const [nx, node, npm] = await Promise.all([
    runner({
      executable: process.execPath,
      args: [nxExecutable, "--version"],
      cwd: workspaceRoot,
    }),
    runner({
      executable: process.execPath,
      args: ["--version"],
      cwd: workspaceRoot,
    }),
    runner({ executable: "npm", args: ["--version"], cwd: workspaceRoot }),
  ]);
  return {
    node: node.stdout.trim(),
    npm: npm.stdout.trim(),
    nx: nx.stdout.trim(),
  };
}

/** Every project name Nx reports, sorted; `nx-native-graph.ts` has `readNativeProjects` for a collected graph. */
export async function readProjects(
  workspaceRoot: string,
  nxExecutable: string,
  runner: NxCommandRunner,
): Promise<readonly string[]> {
  const result = await runNxJson(workspaceRoot, nxExecutable, runner, ["show", "projects", "--json"], "project list");
  if (!Array.isArray(result) || !result.every((entry) => typeof entry === "string")) {
    throw new Error("Unsupported Nx interface: `nx show projects --json` did not return a JSON string array.");
  }
  return [...result].sort();
}

/** One project's fully resolved configuration, exactly as Nx reported it; `nx-native-graph.ts` has `readNativeProject` for a graph node. */
export async function readNxProjectConfiguration(
  workspaceRoot: string,
  nxExecutable: string,
  runner: NxCommandRunner,
  name: string,
): Promise<JsonValue> {
  return runNxJson(workspaceRoot, nxExecutable, runner, ["show", "project", name, "--json"], `project ${name}`);
}

/**
 * The project graph, collected through a uniquely named scratch file that is
 * removed whether or not Nx succeeded, so a failed import leaves nothing
 * behind in someone else's workspace.
 */
export async function readProjectGraph(
  workspaceRoot: string,
  nxExecutable: string,
  runner: NxCommandRunner,
): Promise<JsonValue> {
  const graphName = `.dads.testing.nx-graph.${randomUUID()}.json`;
  const graphPath = path.join(workspaceRoot, graphName);
  try {
    await runner({
      executable: process.execPath,
      args: [nxExecutable, "graph", `--file=${graphName}`, "--open=false"],
      cwd: workspaceRoot,
    });
    const raw = await fs.readFile(graphPath, "utf8");
    return parseJson(raw, "Nx project graph");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown graph collection failure.";
    throw new Error(`Unsupported Nx interface: could not collect a machine-readable project graph (${message}).`, {
      cause: error,
    });
  } finally {
    await fs.rm(graphPath, { force: true });
  }
}

/** Runs one Nx command and parses its stdout as JSON. */
async function runNxJson(
  workspaceRoot: string,
  nxExecutable: string,
  runner: NxCommandRunner,
  args: readonly string[],
  subject: string,
): Promise<JsonValue> {
  try {
    const result = await runner({
      executable: process.execPath,
      args: [nxExecutable, ...args],
      cwd: workspaceRoot,
    });
    return parseJson(result.stdout, `Nx ${subject}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown Nx command failure.";
    throw new Error(`Unable to read Nx ${subject}: ${message}`, {
      cause: error,
    });
  }
}

// --- nx.json -------------------------------------------------------------

/** Parses a JSONC configuration file, or `undefined` when it is absent. */
export async function readOptionalJson(filePath: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const value = parseNxConfiguration(await fs.readFile(filePath, "utf8"), filePath);
    if (!isRecord(value)) throw new Error(`${filePath} must be a JSON object.`);
    return value;
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/** Every plugin name `nx.json` declares, in either supported spelling. */
export function readNxPlugins(record: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const value = record?.["plugins"];
  if (value === undefined) return [];
  if (!isUnknownArray(value))
    throw new Error("Invalid nx.json plugins: plugins must be an array of names or plugin objects.");
  const names = new Set<string>();
  for (const entry of value) names.add(readNxPluginName(entry));
  return [...names].sort();
}

/** One plugin entry's name, whether it was written as a string or an object. */
function readNxPluginName(entry: unknown): string {
  if (typeof entry === "string" && entry.trim() !== "") return entry;
  const plugin = isRecord(entry) ? entry["plugin"] : undefined;
  if (typeof plugin === "string" && plugin.trim() !== "") return plugin;
  throw new Error("Invalid nx.json plugins: every plugin object must provide a non-empty string plugin field.");
}

// --- Projects and targets ------------------------------------------------

/** Turns one `nx show project` answer into the project shape Dads imports. */
export function parseProject(value: JsonValue, fallbackName: string): NxProject {
  if (!isJsonRecord(value)) throw new Error(`Nx project ${fallbackName} is not an object.`);
  const name = readOptionalString(value, "name") ?? fallbackName;
  const root = readOptionalString(value, "root") ?? ".";
  const targetRecord = readOptionalJsonRecord(value, "targets") ?? {};
  const targets = Object.entries(targetRecord).map(([targetName, targetValue]) => parseTarget(targetName, targetValue));
  return {
    name,
    id: dadsIdentifier(name),
    root: normalizeRoot(root),
    targets: targets.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Reads one target, keeping only the fields this importer can honor and
 * recording every other field twice: once as dropped, and once as a reason the
 * target may not be safe to materialize at all.
 */
function parseTarget(name: string, value: JsonValue): NxTarget {
  if (!isJsonRecord(value)) return unreadableTarget(name);
  const options = readOptionalJsonRecord(value, "options");
  const executor = readOptionalString(value, "executor");
  const command = options ? readOptionalString(options, "command") : undefined;
  const cwd = options ? readOptionalString(options, "cwd") : undefined;
  return {
    name,
    id: dadsIdentifier(name),
    ...(executor === undefined ? {} : { executor }),
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    continuous: readOptionalBoolean(value, "continuous") === true,
    inferred: readOptionalJsonRecord(value, "metadata") !== undefined,
    unresolvedExecutionFields: unresolvedExecutionFields(value, options),
    droppedFields: droppedTargetFields(value, options),
  };
}

/** A target Nx did not describe as an object carries nothing but its name. */
function unreadableTarget(name: string): NxTarget {
  return {
    name,
    id: dadsIdentifier(name),
    continuous: false,
    inferred: false,
    unresolvedExecutionFields: ["target:non-object"],
    droppedFields: ["target:non-object"],
  };
}

/** Fields that change what running a target does, so it cannot be imported. */
function unresolvedExecutionFields(value: JsonRecord, options: JsonRecord | undefined): readonly string[] {
  const configuration = Object.keys(value).filter((key) => executionAffectingFields.includes(key));
  return [...configuration, ...unsupportedOptionFields(options)].sort();
}

/** Every field of the target that the imported recipe does not carry. */
function droppedTargetFields(value: JsonRecord, options: JsonRecord | undefined): readonly string[] {
  const topLevel = Object.keys(value).filter((key) => !carriedTargetFields.includes(key));
  return [...topLevel, ...unsupportedOptionFields(options)].sort();
}

/** The `options.*` fields other than the command and its directory. */
function unsupportedOptionFields(options: JsonRecord | undefined): readonly string[] {
  if (!options) return [];
  return Object.keys(options)
    .filter((key) => !carriedOptionFields.includes(key))
    .map((key) => `options.${key}`);
}

// --- Workspace-relative paths --------------------------------------------

/** A workspace-relative POSIX path, with `.` standing for the root itself. */
export function normalizeRoot(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll(path.sep, "/"));
  return normalized === "" ? "." : normalized.replace(/^\.\//, "") || ".";
}

/** Where `candidate` sits relative to the workspace root. */
export function relativeLocation(workspaceRoot: string, candidate: string): string {
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute);
  return relative === "" ? "." : normalizeRoot(relative);
}

/** True for the one read failure that means "this file simply is not here". */
export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error["code"] === "ENOENT";
}

// --- Running commands ----------------------------------------------------

/** The default runner: a direct child process with no shell in between. */
export async function runProcess(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    let stdout = "";
    let stderr = "";
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const exitStatus = code === null ? "without a status" : String(code);
      reject(new Error(`${input.executable} ${input.args.join(" ")} exited ${exitStatus}: ${stderr.trim()}`));
    });
  });
}
