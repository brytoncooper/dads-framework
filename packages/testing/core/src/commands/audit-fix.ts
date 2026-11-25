import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isRecord, readStringList } from "../parse-guards.js";
import { planTesting } from "../testing-api.js";
import { defaultTestingManifestFileName } from "../testing-manifest.js";
import { writeFilesAtomically } from "../write-files-atomically.js";

const siblingCollapseThreshold = 3;

export type AuditPathProposal = {
  readonly taskId: string;
  readonly project?: string;
  readonly suggestedPaths: readonly string[];
};

export type AuditFixOutcome = {
  readonly manifestPath: string;
  readonly applied: boolean;
  readonly changes: Readonly<Record<string, readonly string[]>>;
};

/**
 * Collapses `>= 3` undeclared sibling files sharing the same non-root parent
 * directory into `<dir>/**`, dropping paths already covered by a collapsed dir.
 */
export function collapseAuditImpactPaths(rawPaths: readonly string[]): readonly string[] {
  const unique = [...new Set(rawPaths.filter((entry) => entry.length > 0))].sort();
  const collapsedDirs = collectCollapsibleDirs(unique);
  const result = new Set<string>();
  for (const dir of collapsedDirs) {
    result.add(`${dir}/**`);
  }
  for (const entry of unique) {
    if (!isCoveredByCollapsedDir(entry, collapsedDirs)) {
      result.add(entry);
    }
  }
  return [...result].sort();
}

function collectCollapsibleDirs(sortedPaths: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const entry of sortedPaths) {
    if (entry === ".") continue;
    const slash = entry.lastIndexOf("/");
    if (slash <= 0) continue;
    const parent = entry.slice(0, slash);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const dirs: string[] = [];
  for (const [dir, count] of counts) {
    if (count >= siblingCollapseThreshold) {
      dirs.push(dir);
    }
  }
  return dirs.sort();
}

function isCoveredByCollapsedDir(entry: string, collapsedDirs: readonly string[]): boolean {
  for (const dir of collapsedDirs) {
    if (entry === dir || entry.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Patches `dads.testing.json` (both static `tasks[].impact.paths` and
 * `workspace.discover.taskOverrides`) with audited impact paths, validates the
 * patched manifest with `planTesting` on a temp copy, and writes atomically.
 */
export async function applyAuditManifestFixes(input: {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly proposals: readonly AuditPathProposal[];
  readonly dryRun: boolean;
  readonly nativeBinary?: string;
}): Promise<AuditFixOutcome> {
  const manifestRel = input.manifestPath ?? defaultTestingManifestFileName;
  const manifestAbs = resolveManifestInsideWorkspace(input.workspaceRoot, manifestRel);
  const document = parseRawManifestObject(manifestAbs, manifestRel);
  const changes: Record<string, readonly string[]> = {};

  for (const proposal of input.proposals) {
    if (proposal.suggestedPaths.length === 0) continue;
    const added = patchManifestForTask(document, proposal);
    if (added.length > 0) {
      changes[proposal.taskId] = added;
    }
  }

  const hasChanges = Object.keys(changes).length > 0;
  if (!hasChanges || input.dryRun) {
    return { manifestPath: manifestRel, applied: false, changes };
  }

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await validatePatchedManifest(input.workspaceRoot, manifestAbs, serialized, input.nativeBinary);
  writeFilesAtomically([{ path: manifestAbs, contents: serialized }]);
  return { manifestPath: manifestRel, applied: true, changes };
}

function resolveManifestInsideWorkspace(workspaceRoot: string, manifestRel: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, manifestRel);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`The manifest path must stay inside the workspace: ${manifestRel}`);
  }
  return target;
}

function parseRawManifestObject(manifestAbs: string, manifestRel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestAbs, "utf8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${manifestRel}: unable to parse manifest (${detail})`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${manifestRel}: manifest root must be a JSON object.`);
  }
  return parsed;
}

function patchManifestForTask(document: Record<string, unknown>, proposal: AuditPathProposal): readonly string[] {
  const staticTask = findStaticTask(document, proposal.taskId);
  if (staticTask !== undefined) {
    return mergeStaticTaskImpactPaths(staticTask, proposal.suggestedPaths);
  }
  const discover = findWorkspaceDiscover(document);
  if (discover !== undefined) {
    return mergeDiscoverTaskOverride(discover, proposal);
  }
  throw new Error(
    `Cannot patch impact.paths for task '${proposal.taskId}': not found in tasks[] and workspace.discover is absent.`,
  );
}

function findStaticTask(document: Record<string, unknown>, taskId: string): Record<string, unknown> | undefined {
  const tasks = document["tasks"];
  if (!Array.isArray(tasks)) return undefined;
  for (const entry of tasks) {
    if (isRecord(entry) && entry["id"] === taskId) {
      return entry;
    }
  }
  return undefined;
}

function findWorkspaceDiscover(document: Record<string, unknown>): Record<string, unknown> | undefined {
  const workspace = document["workspace"];
  if (!isRecord(workspace)) return undefined;
  const discover = workspace["discover"];
  return isRecord(discover) ? discover : undefined;
}

function mergeStaticTaskImpactPaths(
  task: Record<string, unknown>,
  suggestedPaths: readonly string[],
): readonly string[] {
  const impact = task["impact"];
  if (!isRecord(impact)) {
    throw new Error("Task entry is missing an impact object.");
  }
  const existing = readStringList(impact["paths"]);
  const { merged, added } = mergeUniquePaths(existing, suggestedPaths);
  if (added.length > 0) {
    impact["paths"] = merged;
  }
  return added;
}

function mergeDiscoverTaskOverride(discover: Record<string, unknown>, proposal: AuditPathProposal): readonly string[] {
  const { projectId, targetName } = splitTaskProjectAndTarget(proposal.taskId, proposal.project);
  const overrides = ensureArrayField(discover, "taskOverrides");
  const existingOverride = findSingleProjectOverride(overrides, projectId, targetName);
  if (existingOverride !== undefined) {
    const current = readStringList(existingOverride["addImpactPaths"]);
    const { merged, added } = mergeUniquePaths(current, proposal.suggestedPaths);
    if (added.length > 0) {
      existingOverride["addImpactPaths"] = merged;
    }
    return added;
  }
  const sorted = [...new Set(proposal.suggestedPaths)].sort();
  overrides.push({
    target: targetName,
    when: { projects: [projectId] },
    addImpactPaths: sorted,
  });
  return sorted;
}

function splitTaskProjectAndTarget(
  taskId: string,
  project: string | undefined,
): { readonly projectId: string; readonly targetName: string } {
  if (project !== undefined && taskId.startsWith(`${project}:`)) {
    return { projectId: project, targetName: taskId.slice(project.length + 1) };
  }
  const colon = taskId.indexOf(":");
  if (colon <= 0 || colon === taskId.length - 1) {
    throw new Error(`Cannot derive project and target for discover task '${taskId}'.`);
  }
  return { projectId: taskId.slice(0, colon), targetName: taskId.slice(colon + 1) };
}

function findSingleProjectOverride(
  overrides: readonly unknown[],
  projectId: string,
  targetName: string,
): Record<string, unknown> | undefined {
  for (const item of overrides) {
    if (!isRecord(item) || item["target"] !== targetName) continue;
    const when = item["when"];
    if (!isRecord(when)) continue;
    const keys = Object.keys(when);
    const projects = when["projects"];
    if (
      keys.length === 1 &&
      keys[0] === "projects" &&
      Array.isArray(projects) &&
      projects.length === 1 &&
      projects[0] === projectId
    ) {
      return item;
    }
  }
  return undefined;
}

function ensureArrayField(container: Record<string, unknown>, key: string): unknown[] {
  const current = container[key];
  if (Array.isArray(current)) return current;
  const created: unknown[] = [];
  container[key] = created;
  return created;
}

function mergeUniquePaths(
  existing: readonly string[],
  incoming: readonly string[],
): { readonly merged: readonly string[]; readonly added: readonly string[] } {
  const existingSet = new Set(existing);
  const added = [...new Set(incoming)].filter((entry) => !existingSet.has(entry)).sort();
  return { merged: [...existing, ...added], added };
}

async function validatePatchedManifest(
  workspaceRoot: string,
  manifestAbs: string,
  contents: string,
  nativeBinary: string | undefined,
): Promise<void> {
  const root = resolve(workspaceRoot);
  const tempAbs = join(dirname(manifestAbs), `.dads-testing-audit-${randomUUID()}.tmp.json`);
  const tempRel = relative(root, tempAbs).replace(/\\/g, "/");
  writeFileSync(tempAbs, contents, "utf8");
  try {
    await planTesting({
      workspaceRoot: root,
      manifestPath: tempRel,
      all: true,
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });
  } finally {
    rmSync(tempAbs, { force: true });
  }
}
