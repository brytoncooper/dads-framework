import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  readWorkspaceBoundaries,
  serializeWorkspaceBoundaries,
  type TestingManifestDepConstraint,
  type TestingManifestWorkspaceBoundaries,
} from "./testing-manifest-boundaries.js";
import {
  readArray,
  readEnumeration,
  readOptionalStringArray,
  readRecord,
  readString,
  readStringArray,
  rejectUnknownKeys,
} from "./testing-manifest-readers.js";
import {
  readTaskSqlImpact,
  readWorkspaceSql,
  serializeTaskSqlImpact,
  serializeWorkspaceSql,
  type TestingManifestSqlEdge,
  type TestingManifestSqlSnapshotPattern,
  type TestingManifestTaskSqlImpact,
  type TestingManifestWorkspaceSql,
} from "./testing-manifest-sql.js";

export type {
  TestingManifestDepConstraint,
  TestingManifestSqlEdge,
  TestingManifestSqlSnapshotPattern,
  TestingManifestTaskSqlImpact,
  TestingManifestWorkspaceBoundaries,
  TestingManifestWorkspaceSql,
};

/**
 * A TypeScript reader and writer for `dads.testing.json`. The native engine owns
 * manifest semantics; this module owns the same document shape for tooling that
 * generates or inspects a manifest without starting the engine. Validation is
 * strict in the same way: unknown keys are rejected rather than ignored, so a
 * misspelled key is never silently dropped.
 */

export type TestingManifest = {
  readonly schemaVersion: 1;
  readonly workspace: {
    readonly root?: string;
    readonly fullFallback: { readonly taskIds: readonly string[] };
    readonly sql?: TestingManifestWorkspaceSql;
    readonly nonCodeSuffixes?: readonly string[];
    readonly ignorePaths?: readonly string[];
    readonly dynamicImportScopes?: Readonly<Record<string, readonly string[]>>;
    readonly boundaries?: TestingManifestWorkspaceBoundaries;
  };
  readonly projects: readonly TestingManifestProject[];
  readonly tasks: readonly TestingManifestTask[];
};

export type TestingManifestProject = {
  readonly id: string;
  readonly root: string;
  readonly fallbackDependencies: readonly string[];
  readonly tags?: readonly string[];
};

export type TestingManifestFileNarrowing = {
  readonly suffixes: readonly string[];
  readonly excludeSuffixes?: readonly string[];
  readonly setupFiles?: readonly string[];
};

export type TestingManifestTaskBatch = {
  readonly maxSize: number;
  readonly groupKey?: string;
  readonly sharedArgs?: number;
};

export type TestingManifestTask = {
  readonly id: string;
  readonly project: string;
  readonly kind: TestingManifestTaskKind;
  readonly execution: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly shell?: boolean;
    readonly env?: Readonly<Record<string, string>>;
    readonly fileNarrowing?: TestingManifestFileNarrowing;
    readonly batch?: TestingManifestTaskBatch;
  };
  readonly dependsOn: readonly string[];
  readonly impact: {
    readonly mode: TestingManifestImpactMode;
    readonly paths: readonly string[];
  };
  readonly sqlImpact?: TestingManifestTaskSqlImpact;
  readonly cache?: boolean;
};

export type TestingManifestTaskKind = "test" | "typecheck" | "lint" | "build" | "custom";

export type TestingManifestImpactMode = "reachability" | "changed-files" | "project" | "always";

export const defaultTestingManifestFileName = "dads.testing.json";

const manifestSchemaVersion = 1;

const taskKinds: readonly TestingManifestTaskKind[] = ["test", "typecheck", "lint", "build", "custom"];

const impactModes: readonly TestingManifestImpactMode[] = ["reachability", "changed-files", "project", "always"];

/**
 * Reads the manifest for a workspace. The resolved manifest path must stay
 * inside the workspace root: a manifest outside the workspace would describe
 * paths this workspace does not own.
 */
export function readTestingManifest(workspaceRoot: string, manifestPath?: string): TestingManifest {
  const requestedPath = manifestPath ?? defaultTestingManifestFileName;
  const root = resolve(workspaceRoot);
  const resolvedPath = resolve(root, requestedPath);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
    throw new Error(`The manifest path must stay inside the workspace: ${requestedPath}`);
  }
  return parseTestingManifest(readFileSync(resolvedPath, "utf8"), requestedPath);
}

/**
 * Parses manifest text. `subject` names the document in every error message so
 * a caller reading several manifests can tell them apart.
 */
export function parseTestingManifest(text: string, subject: string): TestingManifest {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${subject}: the manifest is not valid JSON (${detail})`, {
      cause: error,
    });
  }

  const root = readRecord(document, "the manifest", subject);
  rejectUnknownKeys(root, ["schemaVersion", "workspace", "projects", "tasks"], "the manifest", subject);
  if (root["schemaVersion"] !== manifestSchemaVersion) {
    throw new Error(`${subject}: schemaVersion must be 1`);
  }

  return {
    schemaVersion: manifestSchemaVersion,
    workspace: readWorkspace(root["workspace"], subject),
    projects: readArray(root["projects"], "projects", subject).map((project, index) =>
      readProject(project, `projects[${String(index)}]`, subject),
    ),
    tasks: readArray(root["tasks"], "tasks", subject).map((task, index) =>
      readTask(task, `tasks[${String(index)}]`, subject),
    ),
  };
}

/**
 * Serializes a manifest with a fixed key order so a generated manifest is a
 * stable file: regenerating an unchanged manifest produces an unchanged file.
 */
export function serializeTestingManifest(manifest: TestingManifest): string {
  const document = {
    schemaVersion: manifest.schemaVersion,
    workspace: {
      ...(manifest.workspace.root === undefined ? {} : { root: manifest.workspace.root }),
      fullFallback: { taskIds: [...manifest.workspace.fullFallback.taskIds] },
      ...(manifest.workspace.sql === undefined ? {} : { sql: serializeWorkspaceSql(manifest.workspace.sql) }),
      ...(manifest.workspace.nonCodeSuffixes === undefined || manifest.workspace.nonCodeSuffixes.length === 0
        ? {}
        : { nonCodeSuffixes: [...manifest.workspace.nonCodeSuffixes] }),
      ...(manifest.workspace.ignorePaths === undefined || manifest.workspace.ignorePaths.length === 0
        ? {}
        : { ignorePaths: [...manifest.workspace.ignorePaths] }),
      ...(manifest.workspace.dynamicImportScopes === undefined ||
      Object.keys(manifest.workspace.dynamicImportScopes).length === 0
        ? {}
        : { dynamicImportScopes: serializeDynamicImportScopes(manifest.workspace.dynamicImportScopes) }),
      ...(manifest.workspace.boundaries === undefined
        ? {}
        : { boundaries: serializeWorkspaceBoundaries(manifest.workspace.boundaries) }),
    },
    projects: manifest.projects.map((project) => ({
      id: project.id,
      root: project.root,
      fallbackDependencies: [...project.fallbackDependencies],
      ...(project.tags === undefined || project.tags.length === 0 ? {} : { tags: [...project.tags] }),
    })),
    tasks: manifest.tasks.map((task) => ({
      id: task.id,
      project: task.project,
      kind: task.kind,
      execution: {
        executable: task.execution.executable,
        args: [...task.execution.args],
        ...(task.execution.cwd === undefined ? {} : { cwd: task.execution.cwd }),
        ...(task.execution.shell === true ? { shell: true } : {}),
        ...(task.execution.env === undefined || Object.keys(task.execution.env).length === 0
          ? {}
          : { env: serializeEnv(task.execution.env) }),
        ...(task.execution.fileNarrowing === undefined
          ? {}
          : { fileNarrowing: serializeFileNarrowing(task.execution.fileNarrowing) }),
        ...(task.execution.batch === undefined ? {} : { batch: serializeTaskBatch(task.execution.batch) }),
      },
      dependsOn: [...task.dependsOn],
      impact: { mode: task.impact.mode, paths: [...task.impact.paths] },
      ...(task.sqlImpact === undefined ? {} : { sqlImpact: serializeTaskSqlImpact(task.sqlImpact) }),
      ...(task.cache === undefined || task.cache ? {} : { cache: false }),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readWorkspace(value: unknown, subject: string): TestingManifest["workspace"] {
  const workspace = readRecord(value, "workspace", subject);
  rejectUnknownKeys(
    workspace,
    ["root", "fullFallback", "sql", "nonCodeSuffixes", "ignorePaths", "dynamicImportScopes", "boundaries"],
    "workspace",
    subject,
  );
  const fullFallback = readRecord(workspace["fullFallback"], "workspace.fullFallback", subject);
  rejectUnknownKeys(fullFallback, ["taskIds"], "workspace.fullFallback", subject);
  const root = workspace["root"];
  const sql = workspace["sql"];
  const boundaries = workspace["boundaries"];
  const nonCodeSuffixes = readOptionalStringArray(workspace["nonCodeSuffixes"], "workspace.nonCodeSuffixes", subject);
  const ignorePaths = readOptionalStringArray(workspace["ignorePaths"], "workspace.ignorePaths", subject);
  const rawScopes = workspace["dynamicImportScopes"];
  const dynamicImportScopes =
    rawScopes === undefined ? undefined : readDynamicImportScopes(rawScopes, "workspace.dynamicImportScopes", subject);
  return {
    ...(root === undefined ? {} : { root: readString(root, "workspace.root", subject) }),
    fullFallback: {
      taskIds: readStringArray(fullFallback["taskIds"], "workspace.fullFallback.taskIds", subject),
    },
    ...(sql === undefined ? {} : { sql: readWorkspaceSql(sql, "workspace.sql", subject) }),
    ...(nonCodeSuffixes.length === 0 ? {} : { nonCodeSuffixes }),
    ...(ignorePaths.length === 0 ? {} : { ignorePaths }),
    ...(dynamicImportScopes === undefined || Object.keys(dynamicImportScopes).length === 0
      ? {}
      : { dynamicImportScopes }),
    ...(boundaries === undefined
      ? {}
      : { boundaries: readWorkspaceBoundaries(boundaries, "workspace.boundaries", subject) }),
  };
}

function readProject(value: unknown, where: string, subject: string): TestingManifestProject {
  const project = readRecord(value, where, subject);
  rejectUnknownKeys(project, ["id", "root", "fallbackDependencies", "tags"], where, subject);
  const tags = readOptionalStringArray(project["tags"], `${where}.tags`, subject);
  return {
    id: readString(project["id"], `${where}.id`, subject),
    root: readString(project["root"], `${where}.root`, subject),
    fallbackDependencies: readOptionalStringArray(
      project["fallbackDependencies"],
      `${where}.fallbackDependencies`,
      subject,
    ),
    ...(tags.length === 0 ? {} : { tags }),
  };
}

function readTask(value: unknown, where: string, subject: string): TestingManifestTask {
  const task = readRecord(value, where, subject);
  rejectUnknownKeys(
    task,
    ["id", "project", "kind", "execution", "dependsOn", "impact", "sqlImpact", "cache"],
    where,
    subject,
  );
  const sqlImpact = task["sqlImpact"];
  const cache = task["cache"];
  if (cache !== undefined && typeof cache !== "boolean") {
    throw new Error(`${subject}: ${where}.cache must be a boolean.`);
  }
  return {
    id: readString(task["id"], `${where}.id`, subject),
    project: readString(task["project"], `${where}.project`, subject),
    kind: readEnumeration(task["kind"], taskKinds, `${where}.kind`, subject),
    execution: readExecution(task["execution"], `${where}.execution`, subject),
    dependsOn: readOptionalStringArray(task["dependsOn"], `${where}.dependsOn`, subject),
    impact: readImpact(task["impact"], `${where}.impact`, subject),
    ...(sqlImpact === undefined ? {} : { sqlImpact: readTaskSqlImpact(sqlImpact, `${where}.sqlImpact`, subject) }),
    ...(cache === undefined ? {} : { cache }),
  };
}

function readExecution(value: unknown, where: string, subject: string): TestingManifestTask["execution"] {
  const execution = readRecord(value, where, subject);
  rejectUnknownKeys(execution, ["executable", "args", "cwd", "shell", "env", "fileNarrowing", "batch"], where, subject);
  const cwd = execution["cwd"];
  const shell = execution["shell"];
  const env = execution["env"];
  const fileNarrowing = execution["fileNarrowing"];
  const batch = execution["batch"];
  if (shell !== undefined && typeof shell !== "boolean") {
    throw new Error(`${subject}: ${where}.shell must be a boolean`);
  }
  const parsedEnv = env === undefined ? undefined : readEnv(env, `${where}.env`, subject);
  return {
    executable: readString(execution["executable"], `${where}.executable`, subject),
    args: readOptionalStringArray(execution["args"], `${where}.args`, subject),
    ...(cwd === undefined ? {} : { cwd: readString(cwd, `${where}.cwd`, subject) }),
    shell: shell ?? false,
    ...(parsedEnv === undefined || Object.keys(parsedEnv).length === 0 ? {} : { env: parsedEnv }),
    ...(fileNarrowing === undefined
      ? {}
      : { fileNarrowing: readFileNarrowing(fileNarrowing, `${where}.fileNarrowing`, subject) }),
    ...(batch === undefined ? {} : { batch: readTaskBatch(batch, `${where}.batch`, subject) }),
  };
}

function readTaskBatch(value: unknown, where: string, subject: string): TestingManifestTaskBatch {
  const batch = readRecord(value, where, subject);
  rejectUnknownKeys(batch, ["maxSize", "groupKey", "sharedArgs"], where, subject);
  const maxSize = batch["maxSize"];
  if (typeof maxSize !== "number" || !Number.isInteger(maxSize) || maxSize < 2) {
    throw new Error(`${subject}: ${where}.maxSize must be an integer >= 2`);
  }
  const groupKey = batch["groupKey"];
  const sharedArgs = batch["sharedArgs"];
  if (sharedArgs !== undefined && (typeof sharedArgs !== "number" || !Number.isInteger(sharedArgs) || sharedArgs < 0)) {
    throw new Error(`${subject}: ${where}.sharedArgs must be a non-negative integer`);
  }
  return {
    maxSize,
    ...(groupKey === undefined ? {} : { groupKey: readString(groupKey, `${where}.groupKey`, subject) }),
    ...(sharedArgs === undefined ? {} : { sharedArgs }),
  };
}

function serializeTaskBatch(batch: TestingManifestTaskBatch): TestingManifestTaskBatch {
  return {
    maxSize: batch.maxSize,
    ...(batch.groupKey === undefined ? {} : { groupKey: batch.groupKey }),
    ...(batch.sharedArgs === undefined ? {} : { sharedArgs: batch.sharedArgs }),
  };
}

function readEnv(value: unknown, where: string, subject: string): Readonly<Record<string, string>> {
  const record = readRecord(value, where, subject);
  const result: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new Error(`${subject}: ${where} has invalid key "${key}"`);
    }
    const entry = readString(record[key], `${where}.${key}`, subject);
    if (entry.includes("\0")) {
      throw new Error(`${subject}: ${where}.${key} must not contain null bytes`);
    }
    result[key] = entry;
  }
  return result;
}

function serializeEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

function readDynamicImportScopes(
  value: unknown,
  where: string,
  subject: string,
): Readonly<Record<string, readonly string[]>> {
  const record = readRecord(value, where, subject);
  const result: Record<string, readonly string[]> = {};
  for (const key of Object.keys(record).sort()) {
    result[key] = readStringArray(record[key], `${where}.${key}`, subject);
  }
  return result;
}

function serializeDynamicImportScopes(
  scopes: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const sorted: Record<string, readonly string[]> = {};
  for (const key of Object.keys(scopes).sort()) {
    const value = scopes[key];
    if (value !== undefined) sorted[key] = [...value];
  }
  return sorted;
}

function readFileNarrowing(value: unknown, where: string, subject: string): TestingManifestFileNarrowing {
  const narrowing = readRecord(value, where, subject);
  rejectUnknownKeys(narrowing, ["suffixes", "excludeSuffixes", "setupFiles"], where, subject);
  const excludeSuffixes = readOptionalStringArray(narrowing["excludeSuffixes"], `${where}.excludeSuffixes`, subject);
  const setupFiles = readOptionalStringArray(narrowing["setupFiles"], `${where}.setupFiles`, subject);
  return {
    suffixes: readStringArray(narrowing["suffixes"], `${where}.suffixes`, subject),
    ...(excludeSuffixes.length === 0 ? {} : { excludeSuffixes }),
    ...(setupFiles.length === 0 ? {} : { setupFiles }),
  };
}

function serializeFileNarrowing(narrowing: TestingManifestFileNarrowing): TestingManifestFileNarrowing {
  return {
    suffixes: [...narrowing.suffixes],
    ...(narrowing.excludeSuffixes === undefined || narrowing.excludeSuffixes.length === 0
      ? {}
      : { excludeSuffixes: [...narrowing.excludeSuffixes] }),
    ...(narrowing.setupFiles === undefined || narrowing.setupFiles.length === 0
      ? {}
      : { setupFiles: [...narrowing.setupFiles] }),
  };
}

function readImpact(value: unknown, where: string, subject: string): TestingManifestTask["impact"] {
  const impact = readRecord(value, where, subject);
  rejectUnknownKeys(impact, ["mode", "paths"], where, subject);
  return {
    mode: readEnumeration(impact["mode"], impactModes, `${where}.mode`, subject),
    paths: readOptionalStringArray(impact["paths"], `${where}.paths`, subject),
  };
}
