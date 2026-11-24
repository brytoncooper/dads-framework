import type { TestingManifest, TestingManifestProject, TestingManifestTask } from "../testing-manifest.js";

/**
 * The native engine's manifest validation, mirrored in TypeScript so a
 * generated manifest is checked before it reaches disk — including on machines
 * where the native engine is not installed. Every message is worded exactly as
 * the engine words it, so a reader never has to learn two vocabularies for the
 * same rule. The engine stops at the first violation; this returns every one it
 * finds, because a generator wants the whole list at once.
 */
export function checkTestingManifest(manifest: TestingManifest): readonly string[] {
  const messages: string[] = [];
  const root = manifest.workspace.root;
  if (root !== undefined) {
    addRelativePathProblem(messages, root, "workspace.root");
  }
  addDynamicImportScopeProblems(messages, manifest.workspace.dynamicImportScopes);

  const projectIds = addProjectProblems(messages, manifest.projects);
  addUnknownFallbackProblems(messages, manifest.projects, projectIds);

  const taskIds = addTaskProblems(messages, manifest.tasks, projectIds);
  addUnknownDependencyProblems(messages, manifest.tasks, taskIds);
  addCycleProblem(messages, manifest.tasks);

  addFullFallbackProblems(messages, manifest.workspace.fullFallback.taskIds, taskIds);
  if (manifest.tasks.length === 0) {
    messages.push("Manifest must declare at least one task.");
  }
  return messages;
}

/** Collects every declared project id while reporting the ones that cannot be used. */
function addProjectProblems(messages: string[], projects: readonly TestingManifestProject[]): ReadonlySet<string> {
  const projectIds = new Set<string>();
  for (const project of projects) {
    addIdentifierProblem(messages, project.id, "project id");
    if (projectIds.has(project.id)) {
      messages.push(`Duplicate project id ${project.id}.`);
    }
    projectIds.add(project.id);
    addRelativePathProblem(messages, project.root, "project.root");
    for (const dependency of project.fallbackDependencies) {
      if (dependency !== project.id) continue;
      messages.push(`Project ${project.id} cannot fallback-depend on itself.`);
    }
  }
  return projectIds;
}

/** A forward reference is legal, so unknown ids are only knowable in a second pass. */
function addUnknownFallbackProblems(
  messages: string[],
  projects: readonly TestingManifestProject[],
  projectIds: ReadonlySet<string>,
): void {
  for (const project of projects) {
    for (const dependency of project.fallbackDependencies) {
      if (projectIds.has(dependency)) continue;
      messages.push(`Project ${project.id} references unknown fallback dependency ${dependency}.`);
    }
  }
}

/** Collects every declared task id while reporting the ones that cannot be run. */
function addTaskProblems(
  messages: string[],
  tasks: readonly TestingManifestTask[],
  projectIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const taskIds = new Set<string>();
  for (const task of tasks) {
    addIdentifierProblem(messages, task.id, "task id");
    if (taskIds.has(task.id)) messages.push(`Duplicate task id ${task.id}.`);
    taskIds.add(task.id);
    if (!projectIds.has(task.project)) {
      messages.push(`Task ${task.id} references unknown project ${task.project}.`);
    }
    addExecutionProblems(messages, task);
    addImpactProblems(messages, task);
  }
  return taskIds;
}

function addExecutionProblems(messages: string[], task: TestingManifestTask): void {
  if (task.execution.executable.trim().length === 0) {
    messages.push(`Task ${task.id} is missing execution.executable.`);
  }
  const cwd = task.execution.cwd;
  if (cwd !== undefined) {
    addRelativePathProblem(messages, cwd, "execution.cwd");
  }
  const narrowing = task.execution.fileNarrowing;
  if (narrowing !== undefined) {
    if (narrowing.suffixes.length === 0) {
      messages.push(`Task ${task.id} uses execution.fileNarrowing without suffixes.`);
    }
    for (const setupFile of narrowing.setupFiles ?? []) {
      addRelativePathProblem(messages, setupFile, "execution.fileNarrowing.setupFiles");
    }
  }
}

/** `changed-files` is scoped by its paths alone, so an empty list selects nothing. */
function addImpactProblems(messages: string[], task: TestingManifestTask): void {
  for (const path of task.impact.paths) {
    addRelativePathProblem(messages, path, "impact.paths");
  }
  if (task.impact.mode === "changed-files" && task.impact.paths.length === 0) {
    messages.push(`Task ${task.id} uses changed-files impact without paths.`);
  }
}

/** A forward reference is legal, so unknown ids are only knowable in a second pass. */
function addUnknownDependencyProblems(
  messages: string[],
  tasks: readonly TestingManifestTask[],
  taskIds: ReadonlySet<string>,
): void {
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        messages.push(`Task ${task.id} cannot depend on itself.`);
        continue;
      }
      if (taskIds.has(dependency)) continue;
      messages.push(`Task ${task.id} references unknown dependency ${dependency}.`);
    }
  }
}

/**
 * The full fallback is what runs when impact cannot be proven, so it must be
 * every declared task and nothing else.
 */
function addFullFallbackProblems(
  messages: string[],
  fallbackIds: readonly string[],
  taskIds: ReadonlySet<string>,
): void {
  const fallbackSet = new Set(fallbackIds);
  if (fallbackSet.size !== fallbackIds.length) {
    messages.push("fullFallback.taskIds contains duplicate task ids.");
  }
  if (fallbackSet.size !== taskIds.size || [...taskIds].some((id) => !fallbackSet.has(id))) {
    messages.push("workspace.fullFallback.taskIds must contain every declared task exactly once.");
  }
}

function addIdentifierProblem(messages: string[], value: string, field: string): void {
  if (value.length > 0 && !/[^A-Za-z0-9\-_.:]/.test(value)) return;
  messages.push(`${field} must use letters, numbers, -, _, ., or :.`);
}

/**
 * Absoluteness is judged the same way on every platform, because the manifest
 * is a document a workspace shares rather than a local path.
 */
function addRelativePathProblem(messages: string[], value: string, field: string): void {
  if (value.trim().length === 0) {
    messages.push(`${field} must not be empty.`);
    return;
  }
  const isAbsolute = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
  if (isAbsolute || value.split(/[\\/]/).includes("..")) {
    messages.push(`${field} must be a workspace-relative path without parent traversal.`);
  }
}

function addDynamicImportScopeProblems(
  messages: string[],
  scopes: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  if (scopes === undefined) return;
  for (const [loader, prefixes] of Object.entries(scopes)) {
    addRelativePathProblem(messages, loader, "workspace.dynamicImportScopes key");
    if (prefixes.length === 0) {
      messages.push(`workspace.dynamicImportScopes entry '${loader}' must list at least one path prefix.`);
    }
    for (const prefix of prefixes) {
      addRelativePathProblem(messages, prefix, "workspace.dynamicImportScopes prefix");
    }
  }
}

/** Reports the first cycle only: one message names the loop that must be cut. */
function addCycleProblem(messages: string[], tasks: readonly TestingManifestTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = new Set<string>();
  const complete = new Set<string>();

  const visit = (id: string): string | undefined => {
    if (complete.has(id)) return undefined;
    if (active.has(id)) return id;
    const task = byId.get(id);
    if (task === undefined) return undefined;
    active.add(id);
    for (const dependency of task.dependsOn) {
      const found = visit(dependency);
      if (found !== undefined) return found;
    }
    active.delete(id);
    complete.add(id);
    return undefined;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found === undefined) continue;
    messages.push(`Task dependency cycle includes ${found}.`);
    return;
  }
}
