/**
 * Both adoption proofs, one pack, one pool.
 *
 * The fixture proof and the generated-project proof pack the same workspace and
 * then do work that has nothing to do with each other, so run separately they
 * pack twice and leave most of the machine idle twice. Here the packing happens
 * once into one throwaway directory and every task from both proofs queues
 * against a single job budget.
 *
 * Nothing is cached, skipped, or carried over from a previous run: the tarball
 * directory is created and destroyed inside this process, and each proof still
 * runs standalone — `verify-adoption-fixtures.mjs` and
 * `verify-generated-project.mjs` pack for themselves.
 */

import { join, resolve } from "node:path";
import process from "node:process";
import { releaseSubjects } from "../release/release-subjects.mjs";

import {
  adoptionFixturesReceipt,
  createAdoptionFixtureTasks,
} from "./adoption-fixture-tasks.mjs";
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

const LABEL = "adoption proofs";

async function main() {
  const root = process.cwd();
  const [option, directory, ...extra] = process.argv.slice(2);
  if (
    option &&
    (option !== "--packed-directory" || !directory || extra.length)
  ) {
    throw new Error(
      "Usage: verify-adoption.mjs [--packed-directory <release-dir>]",
    );
  }
  const timer = createPhaseTimer();
  const workspace = createAdoptionWorkspace("dads-adoption-");
  try {
    const packages = loadAdoptionPackages(root);
    const context = createProofContext({
      root,
      workRoot: workspace.subdirectory("proofs"),
      packages,
      timer,
    });
    const fixtures = createAdoptionFixtureTasks(context);
    const creator = prepareCreatorInstall(context);
    const tasks = [
      ...fixtures.tasks,
      ...createGeneratedProjectTasks(context, creator),
    ];
    const concurrency = await announceAdoptionJobs(
      LABEL,
      Math.max(packages.size, tasks.length),
    );
    // The packed boundary verification is the pool's tail: it is the longest
    // task, so it starts first and it is the only one still running for most of
    // its life. It fans its own scenarios out, and the budget it should spend
    // is this pool's, measured once here, not a second probe taken while this
    // pool is at full stretch — on a four-core runner that probe reads no idle
    // and puts the tail back in a single lane.
    process.env.DADS_BOUNDARY_JOBS ??= String(concurrency.jobs);
    if (directory) {
      const packed = resolve(root, directory);
      for (const { name, filename } of releaseSubjects(root, packed)) {
        context.tarballs.set(name, join(packed, filename));
      }
    } else {
      await packAdoptionPackages({
        context,
        tarballRoot: workspace.tarballRoot,
        jobs: concurrency.jobs,
      });
    }
    creator.start();
    await runAdoptionTasks({ tasks, jobs: concurrency.jobs, label: LABEL });
    writePhaseTable(LABEL, timer);
    writeReceipt(
      adoptionFixturesReceipt(packages, fixtures, concurrency, timer.report()),
    );
    writeReceipt(generatedProjectReceipt(concurrency, timer.report()));
  } finally {
    workspace.dispose();
  }
}

await main().catch(reportFatal);
