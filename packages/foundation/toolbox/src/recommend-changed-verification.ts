import type { DadsProject } from "./project-orientation.js";
import { collectCandidateTasks } from "./verification/logic/collect-candidate-tasks.js";
import type { VerificationPlan, VerificationTaskRecommendation } from "./verification/verification-contract.js";

export type VerificationRecommendation = {
  readonly packageName: string;
  readonly reason: string;
  readonly commands: readonly string[];
};

export type ChangedVerification = {
  readonly packages: readonly VerificationRecommendation[];
  readonly unownedPaths: readonly string[];
  readonly tasks: readonly VerificationTaskRecommendation[];
  readonly unknownPaths: readonly string[];
  readonly usedFullFallback: boolean;
  readonly complete: boolean;
  readonly issues: readonly string[];
};

export function recommendChangedVerification(
  project: DadsProject,
  changedPaths: readonly string[],
  options: { readonly trustEmptyScope?: boolean } = {},
): ChangedVerification {
  const plan = collectCandidateTasks(project, changedPaths, {
    forceFullFallback: changedPaths.length === 0 && options.trustEmptyScope === false,
    fallbackReason: "The clean checkout has no explicitly trusted baseline.",
  });
  return {
    packages: groupTasksByPackage(plan),
    unownedPaths: plan.unownedPaths,
    tasks: plan.tasks,
    unknownPaths: plan.unknownPaths,
    usedFullFallback: plan.usedFullFallback,
    complete: plan.complete,
    issues: plan.issues,
  };
}

function groupTasksByPackage(plan: VerificationPlan): readonly VerificationRecommendation[] {
  const tasksByPackage = new Map<string, VerificationTaskRecommendation[]>();
  for (const task of plan.tasks) {
    const packageTasks = tasksByPackage.get(task.packageName) ?? [];
    packageTasks.push(task);
    tasksByPackage.set(task.packageName, packageTasks);
  }
  return [...tasksByPackage]
    .map(([packageName, tasks]) => ({
      packageName,
      reason: tasks.map((task) => task.reason).join(" "),
      commands: [...new Set(tasks.map((task) => task.command))],
    }))
    .sort((firstPackage, secondPackage) => firstPackage.packageName.localeCompare(secondPackage.packageName));
}
