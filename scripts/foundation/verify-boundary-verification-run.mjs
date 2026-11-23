/**
 * One baseline, then every scenario at once.
 *
 * The expensive part of the boundary proof is not the scenarios, it is the
 * project they all need: a fixture copied out, its engine vendored in, a git
 * history of its own, and one real verification so that real receipts exist.
 * That is built once. After it, each scenario takes a copy of it, edits its own
 * copy, and runs `dad verify` against it, so twenty proofs cost what the widest
 * one costs instead of what all of them cost end to end.
 *
 * Nothing is cached, reused, or skipped between runs: the baseline and every
 * copy are created inside this process and deleted when it ends, and every
 * scenario still runs the verification it always ran, with the assertion it
 * always made.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { chooseAdoptionJobs, firstFailure, runTaskPool } from "../adoption/adoption-concurrency.mjs";
import { createBoundaryExpectations } from "./verify-boundary-verification-expectations.mjs";
import { copyPreparedProject, createBoundaryProject } from "./verify-boundary-verification-project.mjs";
import { boundaryScenarios, proveBaseline } from "./verify-boundary-verification-scenarios.mjs";

const LABEL = "boundary verification";

export class BoundaryScenarioError extends Error {
  constructor(report) {
    super(report);
    this.name = "BoundaryScenarioError";
  }
}

/**
 * Run the whole proof and return its scenarios in the order they are declared,
 * however the machine happened to interleave them.
 */
export async function runBoundaryProof(paths) {
  const baselineRoot = join(paths.temporaryRoot, "baseline");
  mkdirSync(baselineRoot);
  const baseline = boundarySeat(baselineRoot, paths);
  await proveBaseline(baseline);

  const seats = boundaryScenarios.map((scenario, index) => scenarioSeat(scenario, index, baselineRoot, paths));
  const jobs = await announceScenarioJobs(seats.length);
  const results = await runTaskPool(seats, jobs);
  const failure = firstFailure(results);
  if (failure) throw new BoundaryScenarioError(failureReport(results));
  return [...baseline.expectations.scenarioCounts, ...seats.flatMap((seat) => seat.expectations.scenarioCounts)];
}

/**
 * A project directory with the two things a scenario acts through: the editor
 * that mutates it and the expectations that verify it.
 */
function boundarySeat(projectRoot, paths) {
  return {
    project: createBoundaryProject({
      projectRoot,
      fixtureSource: paths.fixtureSource,
      lockfileSource: paths.lockfileSource,
      accessPackageSource: paths.accessPackageSource,
    }),
    expectations: createBoundaryExpectations({
      projectRoot,
      cliPath: paths.cliPath,
      typescriptBin: paths.typescriptBin,
      vitestBin: paths.vitestBin,
    }),
  };
}

function scenarioSeat(scenario, index, baselineRoot, paths) {
  const projectRoot = join(paths.temporaryRoot, `${String(index).padStart(2, "0")}-${safeName(scenario.name)}`);
  const seat = boundarySeat(projectRoot, paths);
  return {
    ...seat,
    name: scenario.name,
    cost: scenario.cost,
    run: async () => {
      copyPreparedProject(baselineRoot, projectRoot);
      await scenario.run(seat);
    },
  };
}

async function announceScenarioJobs(scenarioCount) {
  const receipt = await chooseAdoptionJobs(process.env.DADS_BOUNDARY_JOBS, scenarioCount);
  process.stderr.write(
    `${LABEL}: ${scenarioCount} scenarios, ${receipt.jobs} at a time (${receipt.mode}, ${receipt.limitingReasons.join("+") || "unbounded"}).\n`,
  );
  return receipt.jobs;
}

function failureReport(results) {
  const lines = [`${LABEL} failed.`, ""];
  for (const result of results) {
    if (result.status !== "failed") continue;
    lines.push(`FAILED ${LABEL} / ${result.name}`, errorMessage(result.error), "");
  }
  const skipped = results.filter((result) => result.status === "skipped");
  if (skipped.length > 0) {
    lines.push(`Not started after the failure: ${skipped.map((result) => result.name).join(", ")}.`, "");
  }
  lines.push(`First failure in declared order: ${firstFailure(results).name}.`);
  return lines.join("\n");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeName(name) {
  return name.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "");
}
