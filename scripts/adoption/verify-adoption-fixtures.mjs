/**
 * Adoption proof: pack every public package, install it into a throwaway
 * project outside this workspace, then compile and run one small program per
 * surface.
 *
 * The programs live in `verify-adoption-fixtures-cases.mjs` and the tasks that
 * install and run them live in `adoption-fixture-tasks.mjs`. This file is the
 * standalone entry point: it owns the throwaway workspace, packs into it, and
 * spends the machine on the tasks. `verify-adoption.mjs` runs the same tasks
 * beside the generated-project proof against one shared pack.
 */

import process from "node:process";

import { adoptionFixturesReceipt, createAdoptionFixtureTasks } from "./adoption-fixture-tasks.mjs";
import { loadAdoptionPackages, packAdoptionPackages } from "./adoption-packing.mjs";
import {
  createAdoptionWorkspace,
  createPhaseTimer,
  createProofContext,
  reportFatal,
  writePhaseTable,
  writeReceipt,
} from "./adoption-proof-run.mjs";
import { announceAdoptionJobs, runAdoptionTasks } from "./adoption-task-runner.mjs";

const LABEL = "adoption fixtures";

async function main() {
  const root = process.cwd();
  const timer = createPhaseTimer();
  const workspace = createAdoptionWorkspace("dads-adoption-");
  try {
    const packages = loadAdoptionPackages(root);
    const context = createProofContext({
      root,
      workRoot: workspace.subdirectory("fixtures"),
      packages,
      timer,
    });
    const fixtures = createAdoptionFixtureTasks(context);
    const concurrency = await announceAdoptionJobs(LABEL, Math.max(packages.size, fixtures.tasks.length));
    await packAdoptionPackages({
      context,
      tarballRoot: workspace.tarballRoot,
      jobs: concurrency.jobs,
    });
    await runAdoptionTasks({
      tasks: fixtures.tasks,
      jobs: concurrency.jobs,
      label: LABEL,
    });
    writePhaseTable(LABEL, timer);
    writeReceipt(adoptionFixturesReceipt(packages, fixtures, concurrency, timer.report()));
  } finally {
    workspace.dispose();
  }
}

await main().catch(reportFatal);
