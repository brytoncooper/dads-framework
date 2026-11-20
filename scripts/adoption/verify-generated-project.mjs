/**
 * Adoption proof: generate projects from the packed creator, install them from
 * the packed workspace, and run what a new adopter would run on their first
 * morning.
 *
 * The tasks live in `generated-project-tasks.mjs`. This file is the standalone
 * entry point: it owns the throwaway workspace, packs into it, and spends the
 * machine on the tasks. `verify-adoption.mjs` runs the same tasks beside the
 * fixture proof against one shared pack.
 */

import process from "node:process";

import {
  loadAdoptionPackages,
  packAdoptionPackages,
} from "./adoption-packing.mjs";
import {
  createAdoptionWorkspace,
  createPhaseTimer,
  createProofContext,
  reportFatal,
  writePhaseTable,
  writeReceipt,
} from "./adoption-proof-run.mjs";
import {
  announceAdoptionJobs,
  runAdoptionTasks,
} from "./adoption-task-runner.mjs";
import {
  createGeneratedProjectTasks,
  generatedProjectReceipt,
  prepareCreatorInstall,
} from "./generated-project-tasks.mjs";

const LABEL = "generated projects";

async function main() {
  const root = process.cwd();
  const timer = createPhaseTimer();
  const workspace = createAdoptionWorkspace("dads-generated-");
  try {
    const packages = loadAdoptionPackages(root);
    const context = createProofContext({
      root,
      workRoot: workspace.subdirectory("projects"),
      packages,
      timer,
    });
    const concurrency = await announceAdoptionJobs(LABEL, packages.size);
    await packAdoptionPackages({
      context,
      tarballRoot: workspace.tarballRoot,
      jobs: concurrency.jobs,
    });
    const creator = prepareCreatorInstall(context);
    creator.start();
    await runAdoptionTasks({
      tasks: createGeneratedProjectTasks(context, creator),
      jobs: concurrency.jobs,
      label: LABEL,
    });
    writePhaseTable(LABEL, timer);
    writeReceipt(generatedProjectReceipt(concurrency, timer.report()));
  } finally {
    workspace.dispose();
  }
}

await main().catch(reportFatal);
