import { stableIds } from "./testing-soundness-lib.mjs";

export function assertNativeRun(result, tasks, selected, oracleOutcomes) {
  if (!result.run || !Array.isArray(result.run.tasks))
    throw new Error("Native run response has no execution receipts.");
  const taskIds = stableIds(tasks.map((task) => task.id));
  const receipts = stableIds(result.run.tasks.map((task) => task.id));
  if (taskIds.join(",") !== receipts.join(",")) throw new Error("Native run did not return every task receipt.");
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const oracle = new Map(oracleOutcomes.map((outcome) => [outcome.id, outcome]));
  const receiptsById = new Map(result.run.tasks.map((task) => [task.id, task]));
  for (const id of selected) {
    for (const dependency of dependencies.get(id) ?? []) {
      if (!selected.includes(dependency)) throw new Error(`Selected task ${id} omitted prerequisite ${dependency}.`);
    }
  }
  for (const receipt of result.run.tasks) {
    const selectedTask = selected.includes(receipt.id);
    if (!selectedTask && receipt.status !== "not-applicable")
      throw new Error(`Skipped task ${receipt.id} has an execution receipt.`);
    if (selectedTask && !["executed", "failed", "blocked"].includes(receipt.status)) {
      throw new Error(`Selected task ${receipt.id} has invalid status ${receipt.status}.`);
    }
    if (receipt.status === "blocked") {
      const dependenciesForTask = dependencies.get(receipt.id) ?? [];
      if (!dependenciesForTask.some((id) => ["failed", "blocked"].includes(receiptsById.get(id)?.status))) {
        throw new Error(`Blocked task ${receipt.id} has no failed prerequisite.`);
      }
      continue;
    }
    if (!selectedTask) continue;
    const outcome = oracle.get(receipt.id);
    if (!outcome) throw new Error(`Native task ${receipt.id} lacks oracle outcome.`);
    const expectedStatus = outcome.status === "passed" ? "executed" : "failed";
    if (receipt.status !== expectedStatus || receipt.exitCode !== outcome.exitCode)
      throw new Error(`Native task ${receipt.id} disagrees with its oracle outcome.`);
  }
  const counts = result.run.counts;
  const failed = result.run.tasks.filter((task) => task.status === "failed").length;
  const blocked = result.run.tasks.filter((task) => task.status === "blocked").length;
  const executed = result.run.tasks.filter((task) => ["executed", "failed"].includes(task.status)).length;
  const notApplicable = result.run.tasks.filter((task) => task.status === "not-applicable").length;
  if (
    counts?.failed !== failed ||
    counts?.blocked !== blocked ||
    counts?.executed !== executed ||
    counts?.notApplicable !== notApplicable ||
    result.run.exitCode !== (failed > 0 || blocked > 0 ? 1 : 0)
  ) {
    throw new Error("Native run counts or exit code disagree with task receipts.");
  }
  return {
    exitCode: result.run.exitCode,
    counts: result.run.counts,
    tasks: result.run.tasks,
  };
}
