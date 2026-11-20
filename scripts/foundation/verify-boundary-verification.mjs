/**
 * The boundary-verification proof: where its inputs come from, and where its
 * scratch space goes.
 *
 * Everything else is a sibling. The scenarios are in
 * `verify-boundary-verification-scenarios.mjs`, what a scenario may do to a
 * project is in `-project.mjs`, what it may assert is in `-expectations.mjs`,
 * and the baseline-then-fan-out that runs them is in `-run.mjs`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  BoundaryScenarioError,
  runBoundaryProof,
} from "./verify-boundary-verification-run.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "dads-boundary-proof-"));

try {
  const scenarios = await runBoundaryProof({
    temporaryRoot,
    fixtureSource: join(repositoryRoot, "fixtures/boundary-verification"),
    cliPath: fromEnvironment(
      "DADS_BOUNDARY_CLI_PATH",
      "packages/foundation/toolbox/bin/dad.js",
    ),
    typescriptBin: fromEnvironment(
      "DADS_BOUNDARY_TYPESCRIPT_BIN",
      "node_modules/typescript/bin/tsc",
    ),
    vitestBin: fromEnvironment(
      "DADS_BOUNDARY_VITEST_BIN",
      "node_modules/vitest/vitest.mjs",
    ),
    accessPackageSource: fromEnvironment(
      "DADS_BOUNDARY_ACCESS_ROOT",
      "packages/access",
    ),
    lockfileSource: fromEnvironment(
      "DADS_BOUNDARY_LOCKFILE",
      "package-lock.json",
    ),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, scenarios })}\n`);
} catch (error) {
  process.exitCode = 1;
  // A scenario failure is a sentence about the fixture and reads as one; any
  // other error is a bug in this proof, and its stack is the useful part.
  process.stderr.write(`${describeFailure(error)}\n`);
} finally {
  if (process.env["DADS_KEEP_BOUNDARY_PROOF"] === "1") {
    process.stderr.write(`Preserved boundary proof at ${temporaryRoot}\n`);
  } else {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function describeFailure(error) {
  if (error instanceof BoundaryScenarioError) return error.message;
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function fromEnvironment(variable, repositoryPath) {
  return resolve(process.env[variable] ?? join(repositoryRoot, repositoryPath));
}
