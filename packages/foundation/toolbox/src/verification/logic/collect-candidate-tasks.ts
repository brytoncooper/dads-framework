import { posix } from "node:path";
import type { DadsProject } from "../../project-orientation.js";
import type {
  VerificationPlan,
  VerificationTaskDefinition,
  VerificationTaskRecommendation,
  VerificationTaskState,
} from "../verification-contract.js";

type SelectedTask = {
  readonly state: VerificationTaskState;
  readonly reasons: readonly string[];
};

/** What the changed paths alone decided, before dependencies or the full fallback. */
type CandidateSelection = {
  readonly selectedTasks: Map<string, SelectedTask>;
  readonly unownedPaths: readonly string[];
  readonly unknownPaths: readonly string[];
};

/** The selected task ids in execution order, or sorted when the graph cannot be ordered. */
type SelectedTaskOrder = {
  readonly taskIds: readonly string[];
  readonly hasDependencyCycle: boolean;
};

export function collectCandidateTasks(
  project: DadsProject,
  changedPaths: readonly string[],
  options: {
    readonly forceFullFallback?: boolean;
    readonly fallbackReason?: string;
  } = {},
): VerificationPlan {
  const taskDependencies = addAllowedPackageDependencies(project);
  const selection = selectTasksForChangedPaths(
    project,
    normalizeChangedPaths(changedPaths),
  );
  includeDependentTasks(
    project.verificationPolicy.tasks,
    taskDependencies,
    selection.selectedTasks,
  );
  includeTaskDependencies(taskDependencies, selection.selectedTasks);

  const usedFullFallback =
    selection.unknownPaths.length > 0 || options.forceFullFallback === true;
  if (usedFullFallback) {
    selectFullFallbackTasks(project, selection, options.fallbackReason);
    includeTaskDependencies(taskDependencies, selection.selectedTasks);
  }

  const order = orderSelectedTasks(selection.selectedTasks, taskDependencies);
  const issues = describePlanIssues(
    project,
    usedFullFallback,
    order.hasDependencyCycle,
  );
  return {
    tasks: toRecommendations(
      project,
      order.taskIds,
      selection,
      taskDependencies,
    ),
    unownedPaths: selection.unownedPaths,
    unknownPaths: selection.unknownPaths,
    usedFullFallback,
    complete: issues.length === 0,
    issues,
  };
}

function selectTasksForChangedPaths(
  project: DadsProject,
  changedPaths: readonly string[],
): CandidateSelection {
  const selectedTasks = new Map<string, SelectedTask>();
  const unownedPaths: string[] = [];
  const unknownPaths: string[] = [];
  for (const changedPath of changedPaths) {
    const matchingTasks = project.verificationPolicy.tasks.filter((task) =>
      taskMatchesPath(task, changedPath),
    );
    if (!findOwningPackageName(project, changedPath)) {
      unownedPaths.push(changedPath);
    }
    if (matchingTasks.length === 0) {
      unknownPaths.push(changedPath);
      continue;
    }
    for (const task of matchingTasks) {
      selectTask(selectedTasks, task.id, "run", `${changedPath} changed.`);
    }
  }
  return { selectedTasks, unownedPaths, unknownPaths };
}

function selectFullFallbackTasks(
  project: DadsProject,
  selection: CandidateSelection,
  fallbackReason: string | undefined,
): void {
  const reason =
    selection.unknownPaths.length > 0
      ? `The changed scope includes ${selection.unknownPaths.join(", ")}.`
      : (fallbackReason ?? "Conservative full fallback required.");
  for (const fallbackTaskId of project.verificationPolicy.fullFallbackTaskIds) {
    selectTask(
      selection.selectedTasks,
      fallbackTaskId,
      "unknown-scope",
      reason,
    );
  }
}

function orderSelectedTasks(
  selectedTasks: ReadonlyMap<string, SelectedTask>,
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
): SelectedTaskOrder {
  const sortedTaskIds = sortTasksByDependencies(
    selectedTasks,
    dependenciesByTask,
  );
  if (sortedTaskIds === undefined) {
    return {
      taskIds: [...selectedTasks.keys()].sort(),
      hasDependencyCycle: true,
    };
  }
  return { taskIds: sortedTaskIds, hasDependencyCycle: false };
}

function toRecommendations(
  project: DadsProject,
  taskIds: readonly string[],
  selection: CandidateSelection,
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
): readonly VerificationTaskRecommendation[] {
  const taskById = new Map(
    project.verificationPolicy.tasks.map((task) => [task.id, task]),
  );
  return taskIds.flatMap((taskId) => {
    const task = taskById.get(taskId);
    const selectedTask = selection.selectedTasks.get(taskId);
    if (!task || !selectedTask) return [];
    return [toRecommendation(task, selectedTask, dependenciesByTask)];
  });
}

function describePlanIssues(
  project: DadsProject,
  usedFullFallback: boolean,
  hasDependencyCycle: boolean,
): readonly string[] {
  const fallbackIsSafe =
    !usedFullFallback ||
    project.verificationPolicy.fullFallbackTaskIds.length > 0;
  return [
    ...(hasDependencyCycle
      ? ["The verification task graph contains a dependency cycle."]
      : []),
    ...(!fallbackIsSafe
      ? ["Unknown changed paths have no configured full fallback task."]
      : []),
  ];
}

function addAllowedPackageDependencies(
  project: DadsProject,
): ReadonlyMap<string, ReadonlySet<string>> {
  const tasksByPackage = new Map<string, VerificationTaskDefinition[]>();
  for (const task of project.verificationPolicy.tasks) {
    const packageTasks = tasksByPackage.get(task.packageName) ?? [];
    packageTasks.push(task);
    tasksByPackage.set(task.packageName, packageTasks);
  }

  const dependenciesByTask = new Map<string, ReadonlySet<string>>();
  for (const task of project.verificationPolicy.tasks) {
    const dependencies = new Set(task.dependsOn);
    const owningPackage = project.packages.find(
      (packageDeclaration) => packageDeclaration.name === task.packageName,
    );
    for (const allowedDependency of owningPackage?.allowedDependencies ?? []) {
      for (const dependencyTask of tasksByPackage.get(allowedDependency) ??
        []) {
        dependencies.add(dependencyTask.id);
      }
    }
    dependenciesByTask.set(task.id, dependencies);
  }
  return dependenciesByTask;
}

function includeDependentTasks(
  tasks: readonly VerificationTaskDefinition[],
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
  selectedTasks: Map<string, SelectedTask>,
): void {
  let addedTask = true;
  while (addedTask) {
    addedTask = false;
    for (const candidate of tasks) {
      if (selectedTasks.has(candidate.id)) continue;
      const changedDependencies = [
        ...(dependenciesByTask.get(candidate.id) ?? []),
      ].filter((dependencyId) => selectedTasks.has(dependencyId));
      if (changedDependencies.length === 0) continue;
      selectTask(
        selectedTasks,
        candidate.id,
        candidate.reusePolicy === "candidate" ? "pending-provider" : "run",
        `Depends on ${changedDependencies.sort().join(", ")}.`,
      );
      addedTask = true;
    }
  }
}

function includeTaskDependencies(
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
  selectedTasks: Map<string, SelectedTask>,
): void {
  let addedTask = true;
  while (addedTask) {
    addedTask = false;
    for (const [taskId, selectedTask] of [...selectedTasks]) {
      const added = selectMissingDependencies(
        dependenciesByTask,
        selectedTasks,
        taskId,
        selectedTask,
      );
      if (added) addedTask = true;
    }
  }
}

function selectMissingDependencies(
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
  selectedTasks: Map<string, SelectedTask>,
  taskId: string,
  selectedTask: SelectedTask,
): boolean {
  let addedTask = false;
  for (const dependencyId of dependenciesByTask.get(taskId) ?? []) {
    if (selectedTasks.has(dependencyId)) continue;
    selectTask(
      selectedTasks,
      dependencyId,
      selectedTask.state === "unknown-scope" ? "unknown-scope" : "run",
      `Required by ${taskId}.`,
    );
    addedTask = true;
  }
  return addedTask;
}

function sortTasksByDependencies(
  selectedTasks: ReadonlyMap<string, SelectedTask>,
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] | undefined {
  const remainingTaskIds = new Set(selectedTasks.keys());
  const sortedTaskIds: string[] = [];
  while (remainingTaskIds.size > 0) {
    const readyTaskIds = [...remainingTaskIds]
      .filter((taskId) =>
        [...(dependenciesByTask.get(taskId) ?? [])].every(
          (dependencyId) => !remainingTaskIds.has(dependencyId),
        ),
      )
      .sort();
    if (readyTaskIds.length === 0) return undefined;
    for (const taskId of readyTaskIds) {
      remainingTaskIds.delete(taskId);
      sortedTaskIds.push(taskId);
    }
  }
  return sortedTaskIds;
}

function selectTask(
  selectedTasks: Map<string, SelectedTask>,
  taskId: string,
  state: VerificationTaskState,
  reason: string,
): void {
  const existingTask = selectedTasks.get(taskId);
  if (!existingTask) {
    selectedTasks.set(taskId, { state, reasons: [reason] });
    return;
  }
  selectedTasks.set(taskId, {
    state: chooseMoreConservativeState(existingTask.state, state),
    reasons: [...new Set([...existingTask.reasons, reason])],
  });
}

function chooseMoreConservativeState(
  firstState: VerificationTaskState,
  secondState: VerificationTaskState,
): VerificationTaskState {
  const priority: readonly VerificationTaskState[] = [
    "reuse-candidate",
    "pending-provider",
    "run",
    "unknown-scope",
  ];
  return priority.indexOf(firstState) >= priority.indexOf(secondState)
    ? firstState
    : secondState;
}

function toRecommendation(
  task: VerificationTaskDefinition,
  selectedTask: SelectedTask,
  dependenciesByTask: ReadonlyMap<string, ReadonlySet<string>>,
): VerificationTaskRecommendation {
  return {
    taskId: task.id,
    packageName: task.packageName,
    command: task.command,
    state: selectedTask.state,
    reason: selectedTask.reasons.join(" "),
    dependsOn: [...(dependenciesByTask.get(task.id) ?? [])].sort(),
  };
}

function taskMatchesPath(
  task: VerificationTaskDefinition,
  changedPath: string,
): boolean {
  return [...task.sourceInputs, ...task.nonSourceInputs].some((inputPath) =>
    pathIsInsideInput(changedPath, inputPath),
  );
}

function pathIsInsideInput(changedPath: string, inputPath: string): boolean {
  return changedPath === inputPath || changedPath.startsWith(`${inputPath}/`);
}

function findOwningPackageName(
  project: DadsProject,
  changedPath: string,
): string | undefined {
  return project.packages
    .filter(
      (candidate) =>
        changedPath === candidate.root ||
        changedPath.startsWith(`${candidate.root}/`),
    )
    .sort(
      (firstPackage, secondPackage) =>
        secondPackage.root.length - firstPackage.root.length,
    )[0]?.name;
}

function normalizeChangedPaths(changedPaths: readonly string[]): string[] {
  return [...new Set(changedPaths.map(normalizeChangedPath))].sort();
}

function normalizeChangedPath(changedPath: string): string {
  const normalized = posix.normalize(changedPath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(
      `Expected a project-relative changed path, received ${changedPath}.`,
    );
  }
  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}
