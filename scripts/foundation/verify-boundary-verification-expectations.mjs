/**
 * Running `dad verify` against one isolated project, and saying what each
 * scenario expected of it.
 *
 * Every expectation reads the same shape — the task states in the run's JSON
 * report — and records the run's counts, so the proof's output is a list of
 * named scenarios rather than a pass/fail bit. The project and its edits live
 * in `verify-boundary-verification-project.mjs`, and the scenarios that use
 * both live in `verify-boundary-verification-scenarios.mjs`.
 *
 * The run is asynchronous rather than `spawnSync` for one reason: scenarios
 * that own separate copies of the project have nothing to say to each other,
 * so they run at the same time, and a synchronous spawn would hold the whole
 * event loop while one of them waited on a compiler.
 */

import { spawn } from "node:child_process";
import process from "node:process";

export function createBoundaryExpectations({
  projectRoot,
  cliPath,
  typescriptBin,
  vitestBin,
}) {
  const scenarioCounts = [];

  function recordCounts(name, report) {
    scenarioCounts.push({ name, counts: report.counts });
  }

  function taskStates(report) {
    return Object.fromEntries(
      report.results.map((result) => [result.taskId, result.status]),
    );
  }

  async function runVerification(options = {}) {
    // These disposable fixtures model local receipt reuse independently of
    // the host running the adoption proof. The CI-specific scenario opts in.
    const environment = { ...process.env };
    delete environment.CI;
    if (options.ci === true) environment.CI = "true";
    const completed = await runCli({
      projectRoot,
      arguments: [
        cliPath,
        "verify",
        "--changed",
        "--json",
        ...(options.full ? ["--full"] : []),
      ],
      environment: {
        ...environment,
        DADS_TYPESCRIPT_BIN: typescriptBin,
        DADS_VITEST_BIN: vitestBin,
      },
    });
    if (!options.allowFailure && completed.status !== 0) {
      throw new Error(`${completed.stderr}\n${completed.stdout}`.trim());
    }
    if (options.allowFailure && completed.status === 0) {
      throw new Error("Expected boundary verification to fail.");
    }
    const output = JSON.parse(completed.stdout.trim());
    return output.report;
  }

  return {
    scenarioCounts,
    runVerification,

    async expectConsumerExecuted(name) {
      const report = await runVerification();
      const states = taskStates(report);
      if (states["consumer:artifact-check"] !== "executed") {
        throw new Error(
          `${name}: consumer did not execute: ${JSON.stringify(states)}`,
        );
      }
      recordCounts(name, report);
    },

    expectConsumerFailed(name, report) {
      const states = taskStates(report);
      if (states["consumer:artifact-check"] !== "failed") {
        throw new Error(
          `${name}: consumer did not fail: ${JSON.stringify(states)}`,
        );
      }
      recordCounts(name, report);
    },

    expectTaskFailed(name, taskId, report) {
      const states = taskStates(report);
      if (states[taskId] !== "failed") {
        throw new Error(
          `${name}: ${taskId} did not fail: ${JSON.stringify(states)}`,
        );
      }
      recordCounts(name, report);
    },

    expectAllExecuted(name, report) {
      const states = taskStates(report);
      if (
        Object.keys(states).length !== 6 ||
        Object.values(states).some((status) => status !== "executed")
      ) {
        throw new Error(
          `${name}: expected every fallback task to execute: ${JSON.stringify(states)}`,
        );
      }
      recordCounts(name, report);
    },

    expectStates(name, report, expected) {
      const actual = taskStates(report);
      const mismatches = Object.entries(expected).filter(
        ([taskId, status]) => actual[taskId] !== status,
      );
      if (
        mismatches.length > 0 ||
        Object.keys(actual).length !== Object.keys(expected).length
      ) {
        throw new Error(
          `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
        );
      }
      recordCounts(name, report);
    },
  };
}

function runCli({ projectRoot, arguments: commandArguments, environment }) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, commandArguments, {
      cwd: projectRoot,
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (status) => {
      settle({ status, stdout, stderr });
    });
  });
}
