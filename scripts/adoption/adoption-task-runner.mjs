/**
 * The one place an adoption proof turns a list of independent tasks into a run.
 *
 * It picks the job count, spends it, and then reports. Reporting is the part
 * that has to be careful: tasks finish in whatever order the machine allows, so
 * nothing is printed while they run, and afterwards every task is printed in
 * the order it was declared. The first failure in that same declared order is
 * the one that ends the run, so two identical runs blame the same task.
 */

import process from "node:process";

import {
  chooseAdoptionJobs,
  firstFailure,
  runTaskPool,
} from "./adoption-concurrency.mjs";
import { createTaskTranscript, formatFailure } from "./adoption-commands.mjs";

export class AdoptionTaskError extends Error {
  constructor(report) {
    super(report);
    this.name = "AdoptionTaskError";
  }
}

/**
 * Run `tasks` concurrently and fail loudly.
 *
 * Every task is `{ name, run(transcript) }` and does its own phase timing, so
 * a task that installs and then compiles and then runs shows up as three rows
 * in the phase table rather than one opaque one.
 */
export async function runAdoptionTasks({ tasks, jobs, label }) {
  const transcripts = tasks.map((task) => createTaskTranscript(task.name));
  const results = await runTaskPool(
    tasks.map((task, index) => ({
      name: task.name,
      cost: task.cost,
      run: () => task.run(transcripts[index]),
    })),
    jobs,
  );
  const failure = firstFailure(results);
  if (failure) {
    throw new AdoptionTaskError(
      failureReport({ label, tasks, results, transcripts, failure }),
    );
  }
  return results;
}

/**
 * Choose the job count for a task list and say so before spending it, so a
 * slow run can be read back later without guessing what the machine allowed.
 */
export async function announceAdoptionJobs(label, taskCount) {
  const receipt = await chooseAdoptionJobs(
    process.env.DADS_ADOPTION_JOBS,
    taskCount,
  );
  process.stderr.write(
    `${label}: ${taskCount} tasks, ${receipt.jobs} at a time (${receipt.mode}, ${receipt.limitingReasons.join("+") || "unbounded"}).\n`,
  );
  return receipt;
}

function failureReport({ label, tasks, results, transcripts, failure }) {
  const lines = [`${label} failed.`, ""];
  // Tasks that share a prerequisite share its failure. Printing one error many
  // times buries the rest, so a repeat says whose report to read instead.
  const reported = new Map();
  for (const [index, result] of results.entries()) {
    if (result.status !== "failed") continue;
    const name = `${label} / ${tasks[index].name}`;
    const original = reported.get(result.error);
    if (original === undefined) {
      reported.set(result.error, name);
      lines.push(formatFailure(name, result.error, transcripts[index]), "");
      continue;
    }
    lines.push(
      `FAILED ${name}`,
      `  the same failure reported for ${original}`,
      "",
    );
  }
  lines.push(
    `Tasks: ${describeCounts(results)}.`,
    `First failure in declared order: ${failure.name}.`,
  );
  return lines.join("\n");
}

function describeCounts(results) {
  const counts = new Map([
    ["ok", 0],
    ["failed", 0],
    ["skipped", 0],
  ]);
  for (const result of results)
    counts.set(result.status, counts.get(result.status) + 1);
  return [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
}
